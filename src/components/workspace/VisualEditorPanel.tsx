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

import { useMemo, useRef, useState } from "react";
import type { EditChange, EditMode, ElementPin, Pin, ShapePin } from "../../utils/electronVisualEdit";

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
// Arrow-key stepping for numeric inputs (Figma-style): ↑/↓ = ±1, Shift = ±10,
// Alt = ±0.1. Returns the new composed value, or null if the key/unit isn't
// steppable (so the caller can fall through to default behaviour).
const stepValue = (
  value: string,
  unit: string,
  e: React.KeyboardEvent
): string | null => {
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return null;
  if (unit === "auto" || unit === "none") return null;
  const dir = e.key === "ArrowUp" ? 1 : -1;
  const step = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
  const cur = parseFloat(splitVal(value).num || "0") || 0;
  const next = Math.round((cur + dir * step) * 1000) / 1000;
  return compose(String(next), unit);
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
  fill: string; stroke: string;
};

// SVG-ish elements whose colour comes from fill/stroke rather than `color`.
const SVG_TAGS = ["svg", "path", "g", "use", "circle", "rect", "line", "polygon", "polyline", "ellipse"];

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
    fill: rgbToHex(c.fill ?? "#000000"),
    stroke: c.stroke && c.stroke !== "none" ? rgbToHex(c.stroke) : "#000000",
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
        onKeyDown={(e) => {
          const stepped = stepValue(value, unit, e);
          if (stepped !== null) { e.preventDefault(); onChange(stepped); }
        }}
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
    <input
      className="ve-edge"
      value={num}
      onChange={(e) => onChange(compose(e.target.value, "px"))}
      onKeyDown={(e) => {
        const stepped = stepValue(value, "px", e);
        if (stepped !== null) { e.preventDefault(); onChange(stepped); }
      }}
    />
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
  pin, onEdit, onSetNote, onEditOnPage, onRemoveElement, textEditing,
}: {
  pin: ElementPin;
  onEdit: (change: EditChange) => void;
  onSetNote: (note: string) => void;
  onEditOnPage: () => void;
  onRemoveElement: (on: boolean) => void;
  textEditing: boolean;
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
        const isColor = k === "color" || k === "backgroundColor" || k === "borderColor" || k === "fill" || k === "stroke";
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
  // SVG/icon elements have no meaningful CSS typography — hide that section so
  // the inspector only offers icon-relevant controls (fill/stroke/size).
  const isSvgIcon = SVG_TAGS.includes(pin.fingerprint.tag);
  const removed = !!a.remove;

  return (
    <div className="ve-inspector-scroll">
      <div className="ve-el-id">
        <span className="ve-tag">{pin.fingerprint.tag}</span>
        <span className="ve-path" title={pin.fingerprint.path}>{pin.fingerprint.path}</span>
        {pin.detached && <span className="ve-detached" title="This element was replaced by a re-render">stale</span>}
      </div>

      <button
        type="button"
        className={`ve-remove-el${removed ? " undo" : ""}`}
        onClick={() => onRemoveElement(!removed)}
        title={removed ? "Restore this element" : "Remove this element from the page (deletes it in source)"}
      >
        {removed ? <><IconArrowRight /> Restore element</> : <><IconTrash /> Remove element</>}
      </button>
      {removed && <p className="ve-annotations-empty">Marked for deletion — the agent will remove it from the source.</p>}

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

      {!isSvgIcon && (
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
      )}

      <Section title="Background">
        <Row label="Fill" edited={edited("backgroundColor")}><ColorField value={f.backgroundColor} onChange={(v) => set("backgroundColor", v)} /></Row>
      </Section>

      {SVG_TAGS.includes(pin.fingerprint.tag) && (
        <Section title="Icon / SVG">
          <Row label="Fill" edited={edited("fill")}><ColorField value={f.fill} onChange={(v) => set("fill", v)} /></Row>
          <Row label="Stroke" edited={edited("stroke")}><ColorField value={f.stroke} onChange={(v) => set("stroke", v)} /></Row>
        </Section>
      )}

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

      <Section title="Content">
        {pin.textEditable ? (
          textEditing ? (
            <p className="ve-annotations-empty">
              Editing on the page — type directly on the element. Press Enter or Esc (or click away) to finish.
            </p>
          ) : (
            <div
              className="ve-text-display"
              role="button"
              tabIndex={0}
              onClick={onEditOnPage}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onEditOnPage(); } }}
              title="Click to edit this text on the page"
            >
              <IconPencil />
              <span className="ve-text-display-val">
                {(pin.annotation.text?.to ?? pin.text ?? "").trim() || "(empty — click to add text)"}
              </span>
            </div>
          )
        ) : (
          <p className="ve-annotations-empty">
            This element has child elements — edit its text on the specific leaf you pinned.
          </p>
        )}
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

const MODES: { mode: EditMode; label: string; icon: React.ReactNode; hint: string }[] = [
  { mode: "pick", label: "Pick", icon: <IconTarget />, hint: "Pick an element to edit its styles/text" },
  { mode: "comment", label: "Note", icon: <IconCommentTool />, hint: "Click a point to drop a comment" },
  { mode: "rect", label: "Box", icon: <IconRectTool />, hint: "Drag to mark a rectangular region" },
  { mode: "pen", label: "Pen", icon: <IconPenTool />, hint: "Draw a freehand annotation" },
];

const SHAPE_LABEL: Record<string, string> = { comment: "Comment", rect: "Region", pen: "Drawing" };

function ShapeInspector({ pin, onSetNote }: { pin: ShapePin; onSetNote: (note: string) => void }) {
  const [note, setNote] = useState(pin.note ?? "");
  const where =
    pin.kind === "rect" && "w" in pin.geom
      ? `${Math.round(pin.geom.w)}×${Math.round(pin.geom.h)} region`
      : pin.kind === "pen" && "points" in pin.geom
        ? `${pin.geom.points.length}-point stroke`
        : "x" in pin.geom
          ? `point (${Math.round(pin.geom.x)}, ${Math.round(pin.geom.y)})`
          : "";
  return (
    <div className="ve-inspector-scroll">
      <div className="ve-el-id">
        <span className="ve-tag">{SHAPE_LABEL[pin.kind]}</span>
        <span className="ve-path">{where}</span>
      </div>
      <Section title="Instruction">
        <textarea
          className="ve-note"
          placeholder="What should change in this area? (e.g. “add more spacing here”, “this image is blurry”)"
          value={note}
          onChange={(e) => { setNote(e.target.value); onSetNote(e.target.value); }}
          rows={4}
        />
        <p className="ve-annotations-empty">
          This {SHAPE_LABEL[pin.kind].toLowerCase()} is sent to the agent with your note and its
          position on the screenshot — use it for changes a single element edit can’t express.
        </p>
      </Section>
    </div>
  );
}

export function VisualEditorPanel({
  pins,
  selectedN,
  mode,
  busy,
  rev,
  canUndo,
  canRedo,
  textEditingN,
  onSelectPin,
  onRemovePin,
  onEdit,
  onSetNote,
  onSetMode,
  onEditOnPage,
  onRemoveElement,
  onUndo,
  onRedo,
  onApply,
  onClose,
}: {
  pins: Pin[];
  selectedN: number | null;
  mode: EditMode;
  busy?: boolean;
  /** Bumped on undo/redo to force the inspector to re-seed from the new state. */
  rev: number;
  canUndo: boolean;
  canRedo: boolean;
  /** Pin currently being text-edited directly on the page, if any. */
  textEditingN: number | null;
  onSelectPin: (n: number) => void;
  onRemovePin: (n: number) => void;
  onEdit: (n: number, change: EditChange) => void;
  onSetNote: (n: number, note: string) => void;
  onSetMode: (mode: EditMode) => void;
  onEditOnPage: (n: number) => void;
  onRemoveElement: (n: number, on: boolean) => void;
  onUndo: () => void;
  onRedo: () => void;
  onApply: () => void;
  onClose: () => void;
}) {
  const selected = pins.find((p) => p.n === selectedN) ?? null;
  const totalEdits = pins.reduce(
    (acc, p) =>
      acc + (p.kind === "element" ? Object.keys(p.annotation.css).length + (p.annotation.text ? 1 : 0) : 1),
    0
  );

  return (
    <aside className="ve-panel" aria-label="Visual editor inspector">
      <header className="ve-header">
        <span className="ve-title">Visual Edit</span>
        <div className="ve-header-actions">
          <button type="button" className="ve-icon-btn" title="Undo (Ctrl+Z)" onClick={onUndo} disabled={!canUndo}><IconUndo /></button>
          <button type="button" className="ve-icon-btn" title="Redo (Ctrl+Y)" onClick={onRedo} disabled={!canRedo}><IconRedo /></button>
          <button type="button" className="ve-icon-btn" title="Close" onClick={onClose}><IconClose /></button>
        </div>
      </header>

      <div className="ve-pinbar">
        <div className="ve-modebar" role="group" aria-label="Annotation tool">
          {MODES.map((m) => (
            <button
              key={m.mode}
              type="button"
              className={`ve-mode-btn${mode === m.mode ? " active" : ""}`}
              onClick={() => onSetMode(mode === m.mode ? "off" : m.mode)}
              title={m.hint}
              aria-pressed={mode === m.mode}
            >
              {m.icon}<span>{m.label}</span>
            </button>
          ))}
        </div>
        {pins.length > 0 && (
          <div className="ve-pinlist">
            {pins.map((p) => (
              <span
                key={p.n}
                className={`ve-pinchip${p.n === selectedN ? " active" : ""}${p.kind !== "element" ? " shape" : ""}${p.kind === "element" && p.detached ? " stale" : ""}`}
              >
                <button
                  type="button"
                  className="ve-pinchip-n"
                  onClick={() => onSelectPin(p.n)}
                  title={p.kind === "element" ? `${p.fingerprint.tag} · ${p.fingerprint.path}` : SHAPE_LABEL[p.kind]}
                >
                  {p.n}
                </button>
                <button type="button" className="ve-pinchip-x" onClick={() => onRemovePin(p.n)} title="Remove"><IconClose /></button>
              </span>
            ))}
          </div>
        )}
      </div>

      {selected ? (
        selected.kind === "element" ? (
          <PinInspector
            key={`${selected.n}:${rev}`}
            pin={selected}
            onEdit={(change) => onEdit(selected.n, change)}
            onSetNote={(note) => onSetNote(selected.n, note)}
            onEditOnPage={() => onEditOnPage(selected.n)}
            onRemoveElement={(on) => onRemoveElement(selected.n, on)}
            textEditing={textEditingN === selected.n}
          />
        ) : (
          <ShapeInspector key={selected.n} pin={selected} onSetNote={(note) => onSetNote(selected.n, note)} />
        )
      ) : (
        <div className="ve-empty">
          {pins.length === 0
            ? "Pick an element to edit its styles — or use Note / Box / Pen to annotate an area for the agent."
            : "Select an annotation to edit it."}
        </div>
      )}

      <footer className="ve-footer">
        <span className="ve-footer-count">{pins.length} item{pins.length !== 1 ? "s" : ""} · {totalEdits} edit{totalEdits !== 1 ? "s" : ""}</span>
        <button
          type="button"
          className="ve-apply-btn"
          onClick={onApply}
          disabled={busy || totalEdits === 0}
          title="Send the edits + annotations to the agent to reproduce in source"
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
function IconUndo() {
  return <svg className="ve-svg" viewBox="0 0 16 16" width="13" height="13" aria-hidden><path d="M6 4L2.5 7.5 6 11M2.5 7.5H10a3.5 3.5 0 0 1 0 7H7" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function IconRedo() {
  return <svg className="ve-svg" viewBox="0 0 16 16" width="13" height="13" aria-hidden><path d="M10 4l3.5 3.5L10 11M13.5 7.5H6a3.5 3.5 0 0 0 0 7h3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function IconTrash() {
  return <svg className="ve-svg" viewBox="0 0 16 16" width="12" height="12" aria-hidden><path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.5 8.5a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1l.5-8.5M6.5 7v4M9.5 7v4" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function IconPencil() {
  return <svg className="ve-svg" viewBox="0 0 16 16" width="12" height="12" aria-hidden><path d="M11.5 2.5l2 2L6 12l-2.5.5L4 10l7.5-7.5z" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinejoin="round" /></svg>;
}
function IconTarget() {
  return <svg className="ve-svg" viewBox="0 0 16 16" width="13" height="13" aria-hidden><circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.4" fill="none" /><circle cx="8" cy="8" r="1.6" fill="currentColor" /><path d="M8 1v2M8 13v2M1 8h2M13 8h2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>;
}
function IconCommentTool() {
  return <svg className="ve-svg" viewBox="0 0 16 16" width="13" height="13" aria-hidden><path d="M2.5 3h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 3v-3H2.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinejoin="round" /></svg>;
}
function IconRectTool() {
  return <svg className="ve-svg" viewBox="0 0 16 16" width="13" height="13" aria-hidden><rect x="2" y="3.5" width="12" height="9" rx="1" stroke="currentColor" strokeWidth="1.4" fill="none" strokeDasharray="2.4 2" /></svg>;
}
function IconPenTool() {
  return <svg className="ve-svg" viewBox="0 0 16 16" width="13" height="13" aria-hidden><path d="M2 14c1-3 2.5-5 4.5-6.5C9 5.5 11 4 13 2c.5 2-.5 4.5-2.5 6.5C8.5 10.5 5 12 2 14z" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinejoin="round" /></svg>;
}
