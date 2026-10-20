// Every word the renderer shows comes from the catalogue: no text written
// straight into JSX or into a read attribute. Reads the renderer's syntax trees.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

const RENDERER = fileURLToPath(new URL("../../src/renderer/src/", import.meta.url));
/** Text that is not interface copy: the product name, as package.json gives it. */
const LITERALS = new Set([(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { productName: string }).productName]);

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? tsxFiles(path) : entry.name.endsWith(".tsx") ? [path] : [];
  });
}

interface Node {
  type: string;
  [key: string]: unknown;
}

function walk(node: unknown, visit: (node: Node) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  const current = node as Node;
  if (typeof current.type === "string") visit(current);
  for (const [key, value] of Object.entries(current)) {
    if (key !== "loc" && key !== "start" && key !== "end" && key !== "extra") walk(value, visit);
  }
}

const READ_ATTRIBUTES = new Set(["aria-label", "title", "placeholder", "alt"]);

/** JSX text and read attributes holding words, found in the syntax tree. */
export function hardcoded(source: string): string[] {
  const found: string[] = [];
  const ast = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"] });
  walk(ast.program, (node) => {
    if (node.type === "JSXText") {
      const text = String(node.value).trim();
      if (/\p{L}/u.test(text) && !LITERALS.has(text)) found.push(text);
    } else if (node.type === "JSXAttribute") {
      const name = (node.name as { name?: unknown }).name;
      const value = node.value as { type?: string; value?: unknown } | null;
      if (typeof name === "string" && READ_ATTRIBUTES.has(name) && value?.type === "StringLiteral" && /\p{L}/u.test(String(value.value))) {
        found.push(`${name}="${String(value.value)}"`);
      }
    }
  });
  return found;
}

describe("hard-coded interface text", () => {
  it("finds a planted violation", () => {
    expect(hardcoded('<button aria-label="Close">Save</button>').sort()).toEqual(["Save", 'aria-label="Close"']);
    expect(hardcoded("<p>{t(\"a.b\")}</p>")).toEqual([]);
  });

  it("finds none in the renderer", () => {
    const files = tsxFiles(RENDERER);
    expect(files.length).toBeGreaterThan(5);
    const found = files.flatMap((file) => hardcoded(readFileSync(file, "utf8")).map((text) => `${file.slice(RENDERER.length)}: ${text}`));
    expect(found).toEqual([]);
  });
});
