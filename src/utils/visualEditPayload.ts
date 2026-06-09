/**
 * Turns a visual-edit EditTask into the chat-agent handoff: a structured
 * prompt + the target screenshot (added separately as an image attachment).
 *
 * The agent edits SOURCE — never the screenshot, never typed instructions.
 * The deltas are exact ({ from → to }); the number is the join key between
 * the screenshot pins and the annotation set. The agent localizes each pin
 * via its fingerprint (data-loc when present, else the CSS path / text),
 * applies the delta conforming to the file's styling system, then pixel-diffs
 * the result against the attached target (an exact oracle — the user already
 * produced the target visually).
 */

import type { EditTask, Pin } from "./electronVisualEdit";

function describePin(p: Pin): string {
  const lines: string[] = [];
  const fp = p.fingerprint;
  const loc = fp.loc ? ` (source: ${fp.loc})` : "";
  const label = fp.text ? ` “${fp.text}”` : "";
  lines.push(`Pin ${p.n} — <${fp.tag}>${label} at \`${fp.path}\`${loc}${p.detached ? " [node was re-rendered; re-localize via fingerprint]" : ""}`);
  for (const [prop, d] of Object.entries(p.annotation.css)) {
    lines.push(`    • ${prop}: ${d.from} → ${d.to}`);
  }
  if (p.annotation.text) {
    lines.push(`    • text: ${JSON.stringify(p.annotation.text.from)} → ${JSON.stringify(p.annotation.text.to)}`);
  }
  if (p.annotation.note) {
    lines.push(`    • note: ${p.annotation.note}`);
  }
  return lines.join("\n");
}

export function formatVisualEditPrompt(task: EditTask): string {
  const pins = task.annotations.filter(
    (p) => Object.keys(p.annotation.css).length || p.annotation.text || p.annotation.note
  );
  const body = pins.map(describePin).join("\n\n");
  return (
    `I visually edited the page at ${task.url} using the live editor. The attached ` +
    `screenshot is the TARGET — exactly how it should look. Reproduce each numbered ` +
    `pin's change in the SOURCE CODE (not the screenshot), matching each file's ` +
    `existing styling system (Tailwind / CSS module / styled-components / inline):\n\n` +
    `${body}\n\n` +
    `After editing, verify with Playwright: screenshot the re-rendered page at the same ` +
    `viewport and pixel-diff it against the attached target. If it doesn't match, correct ` +
    `the diff and re-verify. Each delta is exact (from → to); the pin numbers are the join ` +
    `key between the screenshot and this list.`
  );
}
