/**
 * Whitespace cleanup for free-text inputs, per the fleet text-cleanup
 * conventions. This is gptimg's own copy of the two patterns it uses — there is
 * no shared package; each app carries a small local helper (see
 * `text-cleanup-conventions`). The algorithms here are the canonical,
 * test-proven shapes from that convention; do not rewrite them.
 *
 * Only the two patterns gptimg actually needs are present:
 *   - `singleLine` — for scalar instruction fields (the vision `check`).
 *   - `multiline`  — for body fields whose line structure matters (the
 *     generate/edit `prompt`).
 * The `multiline-truncation` pattern is intentionally omitted: gptimg has no
 * preview/snippet surface that needs it. Add it (copying the convention's
 * verified version) only if a real case appears.
 *
 * "Whitespace" and "blank" follow the language built-ins, per the convention:
 * `\s`, `String.prototype.trim`, and `l.trim() === ""` already cover the
 * full-width space U+3000 and NBSP, so no character table is maintained. These
 * functions normalize for display/storage tidiness; they do NOT validate, and
 * must never run on identity-bearing fields (filename stems, keys).
 */

/**
 * Collapse a value to a tidy single line.
 *
 * - `flattenLineBreaks` (default `true`): every whitespace run that contains a
 *   line break collapses, whole, into a single ASCII space — so a value pasted
 *   across lines becomes one line, while horizontal spacing typed within a line
 *   is preserved. Switch off to trim only and keep interior line breaks.
 * - `minify` (default `false`): every run of one or more whitespace characters
 *   — including a lone full-width U+3000 — collapses into a single ASCII space.
 *   Because it collapses horizontal whitespace too, `minify` dominates
 *   `flattenLineBreaks`.
 *
 * Both modes always trim the ends.
 */
export function singleLine(
  text: string,
  opts: { flattenLineBreaks?: boolean; minify?: boolean } = {},
): string {
  const { flattenLineBreaks = true, minify = false } = opts;
  if (minify) return text.replace(/\s+/g, " ").trim();
  if (flattenLineBreaks) return text.replace(/\s*[\r\n]+\s*/g, " ").trim();
  return text.trim();
}

/**
 * Clean a multi-line body while preserving its line structure. Newlines are
 * normalized to `\n` as a side effect of splitting on `\r\n|\r|\n`.
 *
 * - `trimLineEnds` (default `true`): drop each line's trailing whitespace.
 *   Switch off for Markdown bodies that use two trailing spaces as a hard break.
 * - `dropEdgeBlankLines` (default `true`): drop blank lines before the first and
 *   after the last visible line.
 * - `collapseBlankLines` (default `false`): reduce interior runs of blank lines
 *   to one. Off by default because an interior blank run is often a deliberate
 *   section break.
 *
 * Indentation is always preserved; a blank line is one whose trimmed form is
 * empty (so a line of spaces or a lone U+3000 counts as blank).
 */
export function multiline(
  text: string,
  opts: {
    trimLineEnds?: boolean;
    dropEdgeBlankLines?: boolean;
    collapseBlankLines?: boolean;
  } = {},
): string {
  const { trimLineEnds = true, dropEdgeBlankLines = true, collapseBlankLines = false } = opts;
  const isBlank = (l: string) => l.trim() === "";
  let lines = text.split(/\r\n|\r|\n/);
  if (trimLineEnds) lines = lines.map((l) => l.replace(/\s+$/, ""));

  let start = 0;
  let end = lines.length;
  if (dropEdgeBlankLines) {
    while (start < end && isBlank(lines[start]!)) start++;
    while (end > start && isBlank(lines[end - 1]!)) end--;
  }

  const out: string[] = [];
  let prevBlank = false;
  for (const line of lines.slice(start, end)) {
    const blank = isBlank(line);
    if (collapseBlankLines && blank && prevBlank) continue;
    out.push(line);
    prevBlank = blank;
  }
  return out.join("\n");
}
