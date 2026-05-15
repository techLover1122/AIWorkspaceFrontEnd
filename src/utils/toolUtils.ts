/**
 * Helpers for rendering Claude Code tool calls in the UI.
 *
 * `formatToolArguments` — produces a short inline string like `(file.ts)` or
 * `(2 args)` to append after a tool name. Mirrors the webui behaviour but
 * with a couple of extra cases for diff/glob/grep tools.
 *
 * `prettyToolInput` — returns a multi-line, human-readable dump of the tool's
 * input object for use inside an expanded <details> panel.
 */

const SINGLE_ARG_KEYS = [
  "file_path",
  "path",
  "command",
  "pattern",
  "url",
  "query",
  "prompt",
  "description",
];

const MAX_INLINE = 60;

/**
 * Inline summary used after the tool name in the collapsed strip.
 * Returns "" if there are no useful args.
 */
export function formatToolArguments(input?: Record<string, unknown>): string {
  if (!input) return "";

  for (const key of SINGLE_ARG_KEYS) {
    const v = input[key];
    if (typeof v === "string" && v) {
      const short = v.length > MAX_INLINE ? `${v.slice(0, MAX_INLINE - 1)}…` : v;
      return short;
    }
  }

  const keys = Object.keys(input);
  if (keys.length === 0) return "";

  // Single non-string arg: show as "key=value"
  if (keys.length === 1) {
    const k = keys[0];
    const v = input[k];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      return `${k}=${String(v)}`;
    }
  }

  return `${keys.length} args`;
}

/**
 * Multi-line dump for the expanded details panel.
 */
export function prettyToolInput(input?: Record<string, unknown>): string {
  if (!input) return "";
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

/**
 * Short, human-friendly tool name. Some Claude Code tools use snake_case
 * or weird casing — normalise to TitleCase / known names.
 */
export function displayToolName(toolName?: string): string {
  if (!toolName) return "tool";
  // Keep canonical names (Bash, Edit, Read, Write, Glob, Grep, etc.) as-is
  if (/^[A-Z]/.test(toolName)) return toolName;
  // Convert snake_case to TitleCase
  return toolName
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join("");
}
