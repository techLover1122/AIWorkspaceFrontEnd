"use client";

// Productionized inspector for the visual-edit tool. Ported from the provided
// VisualEditor.jsx into the project's conventions: TypeScript, plain CSS
// classes (globals.css `.ve-*`) instead of Tailwind, inline SVG instead of
// lucide-react. Three productionizing changes from the demo (per the plan):
//
//   1. Seed from the picked element's CDP computed styles (pin.computed) so
//      every delta's `from` is the element's real value — not a hardcoded
//      INITIAL.
//   2. Wire onEdit to the real sink: applyEdit(sessionId, n, change) which
//      live-applies (preview agent) AND records the { from → to } delta.
//   3. Compose split editor fields (shadow x/y/blur/spread/color/alpha; grid
//      cols/rows) into real CSS *before* they reach the agent — UI-internal
//      field names never leak into the annotation.
//
// The panel also owns multi-pin management (list / select / remove) and the
// "Apply" handoff that ships the payload to the chat agent.

import { useEffect, useMemo, useRef, useState } from "react";
import type { EditChange, Pin } from "../../utils/electronVisualEdit";

/* ───────────────────────── value helpers ───────────────────────── */

const splitVal = (v: string | undefined): { num: string; unit: string } => {
  if (v == null) return { num: "", unit: "px" };
  if (v === "auto" || v === "none") return { num: "", unit: v };
  const m = String(v).match(/^(-?\d*\.?\d+)\s*([a-z%]*)$/i);
  return m ? { num: m[1], unit: m[2] || "px" } : { num: "", unit: "px" };
};
const compose = (num: string, unit: string): string => {
  if (unit === "auto" || unit === "none") return unit;
  if (num === "" || num == null) return "0" + (unit || "px");
  return num + (unit || "px");
};
const clampByte = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
const toHex2 = (n: number) => clampByte(n).toString(16).padStart(2, "0");
const rgbToHex = (v: string): string => {
  if (!v) return "#000000";
  if (v[0] === "#") {
    const h = v.slice(1);
    if (h.length === 3) return "#" + h.split("").map((c) => c + c).join("");
    return v.slice(0, 7);
  }
  const m = v.match(/rgba?\(([^)]+)\)/i);
  if (!m) return "#000000";
  const [r, g, b] = m[1].split(",").map((p) => parseFloat(p));
  return "#" + toHex2(r) + toHex2(g) + toHex2(b);
};
const rgbAlpha = (v: string): number => {
  const m = v.match(/rgba?\(([^)]+)\)/i);
  if (!m) return 1;
  const parts = m[1].split(",");
  return parts.length >= 4 ? parseFloat(parts[3]) : 1;
};
const hexToRgba = (hex: string, a: number): string => {
  const h = hex.replace("#", "");
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(n.slice(0, 2), 16),
    g = parseInt(n.slice(2, 4), 16),
    b = parseInt(n.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};
const humanize = (k: string) =>
  k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).trim();

// repeat(3, 1fr) / "1fr 1fr 1fr" → track count "3". Falls back to "1".
const trackCount = (v: string | undefined): string => {
  if (!v || v === "none") return "1";
  const rep = v.match(/repeat\(\s*(\d+)/i);
  if (rep) return rep[1];
  return String(v.trim().split(/\s+/).length || 1);
};

// computed boxShadow ("rgb(r,g,b) Xpx Ypx Bpx Spx" / "none") → split fields.
type ShadowFields = { shX: string; shY: string; shBlur: string; shSpread: string; shColor: string; shAlpha: number };
const parseShadow = (v: string | undefined): ShadowFields => {
  const fallback = { shX: "0", shY: "0", shBlur: "0", shSpread: "0", shColor: "#000000", shAlpha: 20 };
  if (!v || v === "none") return fallback;
  const colorMatch = v.match(/(rgba?\([^)]+\)|#[0-9a-f]{3,8})/i);
  const color = colorMatch ? colorMatch[1] : "rgb(0,0,0)";
  const rest = v.replace(color, "").trim();
  const nums = rest.match(/-?\d*\.?\d+px/g) || [];
  const px = (i: number) => (nums[i] ? nums[i].replace("px", "") : "0");
  return {
    shX: px(0),
    shY: px(1),
    shBlur: px(2),
    shSpread: px(3),
    shColor: rgbToHex(color),
    shAlpha: Math.round(rgbAlpha(color) * 100),
  };
};

/* ─────────────────────────── field state ─────────────────────────── */

type Fields = {
  width: string; height: string;
  marginTop: string; marginRight: string; marginBottom: string; marginLeft: string;
  paddingTop: string; paddingRight: string; paddingBottom: string; paddingLeft: string;
  display: string; flexDirection: string; justifyContent: string; alignItems: string;
  flexWrap: string; gap: string;
  gridCols: string; gridRows: string;
  fontSize: string; fontWeight: string; lineHeight: string; letterSpacing: string;
  textAlign: string; color: string;
  backgroundColor: string;
  borderWidth: string; borderStyle: string; borderColor: string; borderRadius: string;
  shX: string; shY: string; shBlur: string; shSpread: string; shColor: string; shAlpha: number;
  opacity: number;
};

// Decompose a pin's real computed styles into editor fields.
function seedFields(c: Record<string, string>): Fields {
  const sh = parseShadow(c.boxShadow);
  return {
    width: c.width ?? "auto",
    height: c.height ?? "auto",
    marginTop: c.marginTop ?? "0px", marginRight: c.marginRight ?? "0px",
    marginBottom: c.marginBottom ?? "0px", marginLeft: c.marginLeft ?? "0px",
    paddingTop: c.paddingTop ?? "0px", paddingRight: c.paddingRight ?? "0px",
    paddingBottom: c.paddingBottom ?? "0px", paddingLeft: c.paddingLeft ?? "0px",
    display: c.display ?? "block",
    flexDirection: c.flexDirection ?? "row",
    justifyContent: c.justifyContent ?? "flex-start",
    alignItems: c.alignItems ?? "stretch",
    flexWrap: c.flexWrap ?? "nowrap",
    gap: c.gap && c.gap !== "normal" ? c.gap : "0px",
    gridCols: trackCount(c.gridTemplateColumns),
    gridRows: trackCount(c.gridTemplateRows),
    fontSize: c.fontSize ?? "16px",
    fontWeight: c.fontWeight ?? "400",
    lineHeight: c.lineHeight ?? "normal",
    letterSpacing: c.letterSpacing && c.letterSpacing !== "normal" ? c.letterSpacing : "0px",
    textAlign: c.textAlign ?? "left",
    color: rgbToHex(c.color ?? "#000000"),
    backgroundColor: rgbToHex(c.backgroundColor ?? "#ffffff"),
    borderWidth: c.borderTopWidth ?? "0px",
    borderStyle: c.borderStyle ?? "solid",
    borderColor: rgbToHex(c.borderColor ?? "#000000"),
    borderRadius: c.borderRadius ?? "0px",
    ...sh,
    opacity: Math.round(parseFloat(c.opacity ?? "1") * 100),
  };
}

// Compose the real CSS prop + value for whatever field group changed.
// Returns null for fields that don't map to a CSS edit on their own (the
// shadow / grid groups always resolve to their composite prop).
function composeChange(field: keyof Fields, fields: Fields): { prop: string; value: string } | null {
  switch (field) {
    case "shX": case "shY": case "shBlur": case "shSpread": case "shColor": case "shAlpha":
      return {
        prop: "boxShadow",
        value: `${fields.shX}px ${fields.shY}px ${fields.shBlur}px ${fields.shSpread}px ${hexToRgba(fields.shColor, fields.shAlpha / 100)}`,
      };
    case "gridCols":
      return { prop: "gridTemplateColumns", value: `repeat(${fields.gridCols}, 1fr)` };
    case "gridRows":
      return { prop: "gridTemplateRows", value: `repeat(${fields.gridRows}, 1fr)` };
    case "opacity":
      return { prop: "opacity", value: String(fields.opacity / 100) };
    default:
      return { prop: field, value: String(fields[field]) };
  }
}

// The real computed `from` for a composed prop (truthful baseline = exact
// value captured at pick).
function fromFor(prop: string, computed: Record<string, string>): string {
  if (prop === "borderWidth") return computed.borderTopWidth ?? "0px";
  return computed[prop] ?? "";
}

/* ─────────────────────────── primitives ─────────────────────────── */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="ve-section">
      <div className="ve-section-title">{title}</div>
      <div className="ve-section-body">{children}</div>
    </div>
  );
}

function Row({ label, edited, children }: { label: string; edited?: boolean; children: React.ReactNode }) {
  return (
    <div className="ve-row">
      <span className={`ve-row-label${edited ? " edited" : ""}`}>
        {label}
        {edited && <span className="ve-dot" />}
      </span>
      <div className="ve-row-control">{children}</div>
    </div>
  );
}

function NumberField({
  value, onChange, units = ["px", "%", "auto", "rem", "vh"],
}: { value: string; onChange: (v: string) => void; units?: string[] }) {
  const { num, unit } = splitVal(value);
  const keyword = unit === "auto" || unit === "none";
  return (
    <div className="ve-numfield">
      <input
        type="text" inputMode="decimal" value={keyword ? "" : num} disabled={keyword}
        placeholder={keyword ? unit : "0"}
        onChange={(e) => onChange(compose(e.target.value, unit))}
        className="ve-input ve-num"
      />
      <select className="ve-select ve-unit" value={unit} onChange={(e) => onChange(compose(num, e.target.value))}>
        {units.map((u) => <option key={u} value={u}>{u}</option>)}
      </select>
    </div>
  );
}

function SelectField({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <select className="ve-select" value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

function Segmented({
  value, onChange, options,
}: { value: string; onChange: (v: string) => void; options: { val: string; label: string; icon?: React.ReactNode }[] }) {
  return (
    <div className="ve-segmented">
      {options.map((o) => (
        <button
          key={o.val} type="button" title={o.label}
          className={`ve-seg-btn${value === o.val ? " active" : ""}`}
          onClick={() => onChange(o.val)}
        >
          {o.icon ?? <span>{o.label}</span>}
        </button>
      ))}
    </div>
  );
}

function ColorField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="ve-colorfield">
      <label className="ve-swatch" style={{ backgroundColor: value }}>
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
      </label>
      <input className="ve-input ve-color-hex" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function Slider({ value, onChange, min = 0, max = 100, suffix = "" }: { value: number; onChange: (v: number) => void; min?: number; max?: number; suffix?: string }) {
  return (
    <div className="ve-slider">
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="ve-slider-val">{value}{suffix}</span>
    </div>
  );
}

function Edge({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { num } = splitVal(value);
  return (
    <input className="ve-edge" value={num} onChange={(e) => onChange(compose(e.target.value, "px"))} />
  );
}

function BoxModel({ f, set }: { f: Fields; set: (k: keyof Fields, v: string) => void }) {
  return (
    <div className="ve-boxmodel">
      <div className="ve-bm-label ve-bm-margin">margin</div>
      <Edge value={f.marginTop} onChange={(v) => set("marginTop", v)} />
      <div className="ve-bm-mid">
        <Edge value={f.marginLeft} onChange={(v) => set("marginLeft", v)} />
        <div className="ve-bm-padding">
          <div className="ve-bm-label ve-bm-pad">padding</div>
          <Edge value={f.paddingTop} onChange={(v) => set("paddingTop", v)} />
          <div className="ve-bm-mid">
            <Edge value={f.paddingLeft} onChange={(v) => set("paddingLeft", v)} />
            <div className="ve-bm-core">{splitVal(f.width).num || "auto"} × {splitVal(f.height).num || "auto"}</div>
            <Edge value={f.paddingRight} onChange={(v) => set("paddingRight", v)} />
          </div>
          <Edge value={f.paddingBottom} onChange={(v) => set("paddingBottom", v)} />
        </div>
        <Edge value={f.marginRight} onChange={(v) => set("marginRight", v)} />
      </div>
      <Edge value={f.marginBottom} onChange={(v) => set("marginBottom", v)} />
    </div>
  );
}

/* ─────────────────────── per-pin inspector ─────────────────────── */

function PinInspector({
  pin, onEdit, onSetNote,
}: {
  pin: Pin;
  onEdit: (change: EditChange) => void;
  onSetNote: (note: string) => void;
}) {
  // Seed from the pin's computed styles, then overlay any already-recorded
  // edits so switching back to a pin shows its current state.
  const seed = useMemo(() => {
    const base = seedFields(pin.computed);
    // Reflect existing annotation `to` values back into the fields.
    const a = pin.annotation;
    if (a.css.opacity) base.opacity = Math.round(parseFloat(a.css.opacity.to) * 100);
    if (a.css.boxShadow) Object.assign(base, parseShadow(a.css.boxShadow.to));
    if (a.css.gridTemplateColumns) base.gridCols = trackCount(a.css.gridTemplateColumns.to);
    if (a.css.gridTemplateRows) base.gridRows = trackCount(a.css.gridTemplateRows.to);
    for (const [prop, d] of Object.entries(a.css)) {
      if (["opacity", "boxShadow", "gridTemplateColumns", "gridTemplateRows"].includes(prop)) continue;
      if (prop in base) {
        const key = prop as keyof Fields;
        if (key === "color" || key === "backgroundColor" || key === "borderColor") {
          (base[key] as string) = rgbToHex(d.to);
        } else {
          (base[key] as string) = d.to;
        }
      }
    }
    return base;
  }, [pin]);

  const [f, setF] = useState<Fields>(seed);
  const [note, setNoteState] = useState(pin.annotation.note ?? "");
  const computedRef = useRef(pin.computed);
  computedRef.current = pin.computed;

  const set = (k: keyof Fields, v: string | number) => {
    setF((prev) => {
      const next = { ...prev, [k]: v };
      const composed = composeChange(k, next);
      if (composed) {
        const isColor = k === "color" || k === "backgroundColor" || k === "borderColor";
        const value = isColor ? rgbToHex(composed.value) : composed.value;
        onEdit({
          kind: "css",
          prop: composed.prop,
          value,
          from: fromFor(composed.prop, computedRef.current),
        });
      }
      return next;
    });
  };

  const a = pin.annotation;
  const edited = (...props: string[]) => props.some((p) => p in a.css);

  return (
    <div className="ve-inspector-scroll">
      <div className="ve-el-id">
        <span className="ve-tag">{pin.fingerprint.tag}</span>
        <span className="ve-path" title={pin.fingerprint.path}>{pin.fingerprint.path}</span>
        {pin.detached && <span className="ve-detached" title="This element was replaced by a re-render">stale</span>}
      </div>

      <Section title="Layout">
        <Row label="Width" edited={edited("width")}><NumberField value={f.width} onChange={(v) => set("width", v)} /></Row>
        <Row label="Height" edited={edited("height")}><NumberField value={f.height} onChange={(v) => set("height", v)} /></Row>
      </Section>

      <Section title="Spacing">
        <BoxModel f={f} set={set} />
      </Section>

      <Section title="Display">
        <Row label="Display" edited={edited("display")}>
          <SelectField value={f.display} onChange={(v) => set("display", v)} options={["block", "flex", "grid", "inline-block", "none"]} />
        </Row>
        {f.display === "flex" && (
          <>
            <Row label="Direction" edited={edited("flexDirection")}>
              <Segmented value={f.flexDirection} onChange={(v) => set("flexDirection", v)}
                options={[{ val: "row", label: "Row", icon: <IconArrowRight /> }, { val: "column", label: "Column", icon: <IconArrowDown /> }]} />
            </Row>
            <Row label="Justify" edited={edited("justifyContent")}>
              <SelectField value={f.justifyContent} onChange={(v) => set("justifyContent", v)} options={["flex-start", "center", "flex-end", "space-between", "space-around", "space-evenly"]} />
            </Row>
            <Row label="Align" edited={edited("alignItems")}>
              <SelectField value={f.alignItems} onChange={(v) => set("alignItems", v)} options={["stretch", "flex-start", "center", "flex-end", "baseline"]} />
            </Row>
            <Row label="Wrap" edited={edited("flexWrap")}>
              <SelectField value={f.flexWrap} onChange={(v) => set("flexWrap", v)} options={["nowrap", "wrap", "wrap-reverse"]} />
            </Row>
            <Row label="Gap" edited={edited("gap")}><NumberField value={f.gap} onChange={(v) => set("gap", v)} /></Row>
          </>
        )}
        {f.display === "grid" && (
          <>
            <Row label="Columns" edited={edited("gridTemplateColumns")}><NumberField value={`${f.gridCols}fr`} onChange={(v) => set("gridCols", splitVal(v).num || "1")} units={["fr"]} /></Row>
            <Row label="Rows" edited={edited("gridTemplateRows")}><NumberField value={`${f.gridRows}fr`} onChange={(v) => set("gridRows", splitVal(v).num || "1")} units={["fr"]} /></Row>
            <Row label="Gap" edited={edited("gap")}><NumberField value={f.gap} onChange={(v) => set("gap", v)} /></Row>
          </>
        )}
      </Section>

      <Section title="Typography">
        <Row label="Size" edited={edited("fontSize")}><NumberField value={f.fontSize} onChange={(v) => set("fontSize", v)} units={["px", "rem", "em"]} /></Row>
        <Row label="Weight" edited={edited("fontWeight")}>
          <SelectField value={f.fontWeight} onChange={(v) => set("fontWeight", v)} options={["300", "400", "500", "600", "700", "800"]} />
        </Row>
        <Row label="Line H" edited={edited("lineHeight")}>
          <input className="ve-input" value={f.lineHeight} onChange={(e) => set("lineHeight", e.target.value)} />
        </Row>
        <Row label="Spacing" edited={edited("letterSpacing")}><NumberField value={f.letterSpacing} onChange={(v) => set("letterSpacing", v)} units={["px", "em"]} /></Row>
        <Row label="Align" edited={edited("textAlign")}>
          <Segmented value={f.textAlign} onChange={(v) => set("textAlign", v)}
            options={[{ val: "left", label: "Left", icon: <IconAlign a="left" /> }, { val: "center", label: "Center", icon: <IconAlign a="center" /> }, { val: "right", label: "Right", icon: <IconAlign a="right" /> }, { val: "justify", label: "Justify", icon: <IconAlign a="justify" /> }]} />
        </Row>
        <Row label="Color" edited={edited("color")}><ColorField value={f.color} onChange={(v) => set("color", v)} /></Row>
      </Section>

      <Section title="Background">
        <Row label="Fill" edited={edited("backgroundColor")}><ColorField value={f.backgroundColor} onChange={(v) => set("backgroundColor", v)} /></Row>
      </Section>

      <Section title="Border">
        <Row label="Width" edited={edited("borderWidth")}><NumberField value={f.borderWidth} onChange={(v) => set("borderWidth", v)} units={["px"]} /></Row>
        <Row label="Style" edited={edited("borderStyle")}>
          <SelectField value={f.borderStyle} onChange={(v) => set("borderStyle", v)} options={["solid", "dashed", "dotted", "none"]} />
        </Row>
        <Row label="Color" edited={edited("borderColor")}><ColorField value={f.borderColor} onChange={(v) => set("borderColor", v)} /></Row>
        <Row label="Radius" edited={edited("borderRadius")}><NumberField value={f.borderRadius} onChange={(v) => set("borderRadius", v)} units={["px", "%"]} /></Row>
      </Section>

      <Section title="Box shadow">
        <div className="ve-grid2">
          <Row label="X" edited={edited("boxShadow")}><NumberField value={`${f.shX}px`} onChange={(v) => set("shX", splitVal(v).num)} units={["px"]} /></Row>
          <Row label="Y" edited={edited("boxShadow")}><NumberField value={`${f.shY}px`} onChange={(v) => set("shY", splitVal(v).num)} units={["px"]} /></Row>
          <Row label="Blur" edited={edited("boxShadow")}><NumberField value={`${f.shBlur}px`} onChange={(v) => set("shBlur", splitVal(v).num)} units={["px"]} /></Row>
          <Row label="Spread" edited={edited("boxShadow")}><NumberField value={`${f.shSpread}px`} onChange={(v) => set("shSpread", splitVal(v).num)} units={["px"]} /></Row>
        </div>
        <Row label="Color" edited={edited("boxShadow")}><ColorField value={f.shColor} onChange={(v) => set("shColor", v)} /></Row>
        <Row label="Opacity" edited={edited("boxShadow")}><Slider value={f.shAlpha} onChange={(v) => set("shAlpha", v)} suffix="%" /></Row>
      </Section>

      <Section title="Effects">
        <Row label="Opacity" edited={edited("opacity")}><Slider value={f.opacity} onChange={(v) => set("opacity", v)} suffix="%" /></Row>
      </Section>

      <Section title="Note (optional)">
        <textarea
          className="ve-note"
          placeholder="Intent a control can't express…"
          value={note}
          onChange={(e) => setNoteState(e.target.value)}
          onBlur={() => onSetNote(note)}
          rows={2}
        />
      </Section>

      <div className="ve-annotations">
        <div className="ve-annotations-head">
          <span>Annotations</span>
          <span className="ve-annotations-count">{Object.keys(a.css).length + (a.text ? 1 : 0)} change{Object.keys(a.css).length + (a.text ? 1 : 0) !== 1 ? "s" : ""}</span>
        </div>
        {Object.keys(a.css).length === 0 && !a.text ? (
          <p className="ve-annotations-empty">Edit a property to record a delta.</p>
        ) : (
          <div className="ve-annotations-list">
            {Object.entries(a.css).map(([k, d]) => (
              <div key={k} className="ve-annotation">
                <span className="ve-anno-prop">{humanize(k)}</span>
                <span className="ve-anno-from">{d.from}</span>
                <IconArrowRight />
                <span className="ve-anno-to">{d.to}</span>
              </div>
            ))}
            {a.text && (
              <div className="ve-annotation">
                <span className="ve-anno-prop">Text</span>
                <span className="ve-anno-from">{a.text.from}</span>
                <IconArrowRight />
                <span className="ve-anno-to">{a.text.to}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────── panel shell ─────────────────────────── */

export function VisualEditorPanel({
  pins,
  selectedN,
  picking,
  busy,
  onSelectPin,
  onRemovePin,
  onEdit,
  onSetNote,
  onTogglePicking,
  onApply,
  onClose,
}: {
  pins: Pin[];
  selectedN: number | null;
  picking: boolean;
  busy?: boolean;
  onSelectPin: (n: number) => void;
  onRemovePin: (n: number) => void;
  onEdit: (n: number, change: EditChange) => void;
  onSetNote: (n: number, note: string) => void;
  onTogglePicking: () => void;
  onApply: () => void;
  onClose: () => void;
}) {
  const selected = pins.find((p) => p.n === selectedN) ?? null;
  const totalEdits = pins.reduce(
    (acc, p) => acc + Object.keys(p.annotation.css).length + (p.annotation.text ? 1 : 0),
    0
  );

  return (
    <aside className="ve-panel" aria-label="Visual editor inspector">
      <header className="ve-header">
        <span className="ve-title">Visual Edit</span>
        <button type="button" className="ve-icon-btn" title="Close" onClick={onClose}><IconClose /></button>
      </header>

      <div className="ve-pinbar">
        <button
          type="button"
          className={`ve-pick-btn${picking ? " active" : ""}`}
          onClick={onTogglePicking}
          title={picking ? "Stop picking" : "Pick an element on the page"}
        >
          <IconTarget /> {picking ? "Picking…" : "Pick element"}
        </button>
        <div className="ve-pinlist">
          {pins.map((p) => (
            <span key={p.n} className={`ve-pinchip${p.n === selectedN ? " active" : ""}${p.detached ? " stale" : ""}`}>
              <button type="button" className="ve-pinchip-n" onClick={() => onSelectPin(p.n)} title={`${p.fingerprint.tag} · ${p.fingerprint.path}`}>{p.n}</button>
              <button type="button" className="ve-pinchip-x" onClick={() => onRemovePin(p.n)} title="Remove pin"><IconClose /></button>
            </span>
          ))}
        </div>
      </div>

      {selected ? (
        <PinInspector
          key={selected.n}
          pin={selected}
          onEdit={(change) => onEdit(selected.n, change)}
          onSetNote={(note) => onSetNote(selected.n, note)}
        />
      ) : (
        <div className="ve-empty">
          {pins.length === 0
            ? "Click “Pick element”, then click anything on the page to drop a numbered pin."
            : "Select a pin to edit it."}
        </div>
      )}

      <footer className="ve-footer">
        <span className="ve-footer-count">{pins.length} pin{pins.length !== 1 ? "s" : ""} · {totalEdits} edit{totalEdits !== 1 ? "s" : ""}</span>
        <button
          type="button"
          className="ve-apply-btn"
          onClick={onApply}
          disabled={busy || totalEdits === 0}
          title="Send the edits to the agent to reproduce in source"
        >
          {busy ? "Preparing…" : "Apply in code"}
        </button>
      </footer>
    </aside>
  );
}

/* ─────────────────────────── inline icons ─────────────────────────── */

function IconArrowRight() {
  return <svg className="ve-svg" viewBox="0 0 16 16" width="11" height="11" aria-hidden><path d="M3 8h9M9 5l3 3-3 3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function IconArrowDown() {
  return <svg className="ve-svg" viewBox="0 0 16 16" width="13" height="13" aria-hidden><path d="M8 3v9M5 9l3 3 3-3" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function IconAlign({ a }: { a: "left" | "center" | "right" | "justify" }) {
  const lines: Record<string, string> = {
    left: "M2 4h9M2 8h6M2 12h9",
    center: "M3 4h10M5 8h6M3 12h10",
    right: "M5 4h9M8 8h6M5 12h9",
    justify: "M2 4h12M2 8h12M2 12h12",
  };
  return <svg className="ve-svg" viewBox="0 0 16 16" width="13" height="13" aria-hidden><path d={lines[a]} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
}
function IconClose() {
  return <svg className="ve-svg" viewBox="0 0 16 16" width="11" height="11" aria-hidden><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>;
}
function IconTarget() {
  return <svg className="ve-svg" viewBox="0 0 16 16" width="13" height="13" aria-hidden><circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.4" fill="none" /><circle cx="8" cy="8" r="1.6" fill="currentColor" /><path d="M8 1v2M8 13v2M1 8h2M13 8h2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>;
}
