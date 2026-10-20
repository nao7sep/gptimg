// The window's first paint and the page's --bg are the same colour in both themes.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PAGE_BACKGROUND } from "../../src/shared/page-background.ts";

const tokens = readFileSync(new URL("../../src/renderer/src/styles/tokens.css", import.meta.url), "utf8");
const darkBlock = tokens.slice(tokens.indexOf("@media (prefers-color-scheme: dark)"));
const bg = (css: string) => /--bg:\s*(#[0-9a-fA-F]{6})/.exec(css)?.[1]?.toLowerCase();

describe("the page background", () => {
  it("is the colour windows open with, light and dark", () => {
    expect(bg(tokens)).toBe(PAGE_BACKGROUND.light);
    expect(bg(darkBlock)).toBe(PAGE_BACKGROUND.dark);
  });
});
