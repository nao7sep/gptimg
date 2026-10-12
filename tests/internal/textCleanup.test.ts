import { describe, expect, it } from "vitest";
import { multiline, singleLine } from "../../src/internal/textCleanup.js";

// gptimg uses two of the three text-cleanup patterns: multiline() with defaults
// for the generate/edit prompt, and singleLine() with defaults for the vision
// check. These tests pin the behaviors those call sites rely on, mirroring the
// canonical cases from the text-cleanup-conventions reference.

describe("singleLine (vision check)", () => {
  it("trims the ends", () => {
    expect(singleLine("  hello  ")).toBe("hello");
  });

  it("flattens a line break into a single space (default)", () => {
    expect(singleLine("a\nb")).toBe("a b");
  });

  it("collapses a mixed blank-line break run into one space", () => {
    expect(singleLine("aaa\n \n\nbbb")).toBe("aaa bbb");
  });

  it("preserves interior horizontal spacing by default", () => {
    expect(singleLine("a    b")).toBe("a    b");
  });

  it("keeps a lone full-width space when there is no break (default)", () => {
    expect(singleLine("a　b")).toBe("a　b");
  });

  it("normalizes CRLF breaks to a single space", () => {
    expect(singleLine("a\r\nb")).toBe("a b");
  });

  it("returns empty for an all-whitespace value", () => {
    expect(singleLine("\n\n  \n")).toBe("");
  });

  it("minify collapses every whitespace run, including full-width", () => {
    expect(singleLine("a    b", { minify: true })).toBe("a b");
    expect(singleLine("a　　b", { minify: true })).toBe("a b");
  });

  it("flattenLineBreaks off keeps interior line breaks (trim only)", () => {
    expect(singleLine("  a\nb  ", { flattenLineBreaks: false })).toBe("a\nb");
  });
});

describe("multiline (generate/edit prompt)", () => {
  it("drops edge blank lines and trailing whitespace, keeping indentation", () => {
    expect(multiline("\n\n  hello  \n\n")).toBe("  hello");
  });

  it("trims each line's trailing whitespace", () => {
    expect(multiline("a  \nb  ")).toBe("a\nb");
  });

  it("preserves interior blank lines by default", () => {
    expect(multiline("a\n\n\nb")).toBe("a\n\n\nb");
  });

  it("normalizes CRLF newlines to \\n", () => {
    expect(multiline("a\r\nb\r\nc")).toBe("a\nb\nc");
  });

  it("treats a whitespace-only line as blank", () => {
    expect(multiline("a\n   \nb")).toBe("a\n\nb");
  });

  it("preserves indentation on the first content line", () => {
    expect(multiline("  indented\n    more")).toBe("  indented\n    more");
  });

  it("returns empty for an all-blank body", () => {
    expect(multiline("   \n   ")).toBe("");
  });

  it("is content-preserving: leaves a clean body untouched", () => {
    const clean = "Line one\nLine two\n  indented detail";
    expect(multiline(clean)).toBe(clean);
  });

  it("collapses interior blank runs only when asked", () => {
    expect(multiline("a\n\n\nb", { collapseBlankLines: true })).toBe("a\n\nb");
  });

  it("keeps trailing line whitespace when trimLineEnds is off (markdown)", () => {
    expect(multiline("a  \nb  ", { trimLineEnds: false })).toBe("a  \nb  ");
  });
});
