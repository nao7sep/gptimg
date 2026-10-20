// Which code may import what: the renderer never reaches Node, Electron or the
// main side; only the SDK's worker loads the SDK itself; nothing in the app or
// its tests reaches into the SDK's files, only its public entries
// (sdk-conventions). Derived from the source and test trees, with planted violations.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

/** Every module specifier a source imports or re-exports, static or dynamic, read from its syntax tree. */
export function specifiers(source: string): string[] {
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    const n = node as { type?: string; source?: { type?: string; value?: unknown } | null; [key: string]: unknown };
    const linked = n.type === "ImportDeclaration" || n.type === "ExportNamedDeclaration" || n.type === "ExportAllDeclaration" || n.type === "ImportExpression";
    if (linked && n.source?.type === "StringLiteral" && typeof n.source.value === "string") found.push(n.source.value);
    for (const [key, value] of Object.entries(n)) if (key !== "loc" && value && typeof value === "object") visit(value);
  };
  visit(parse(source, { sourceType: "module", plugins: ["typescript", "jsx", "importAttributes"], createImportExpressions: true }).program);
  return found;
}

// The SDK's public entries, read from its package.json exports.
const SDK_ENTRIES = Object.keys(
  (JSON.parse(readFileSync(join(ROOT, "sdk", "package.json"), "utf8")) as { exports: Record<string, string> }).exports,
).map((entry) => (entry === "." ? "gptimgsdk" : `gptimgsdk/${entry.slice(2)}`));
const SDK_DIR = join(ROOT, "sdk");

function violations(file: string, imported: string): string | null {
  if (imported.startsWith("gptimgsdk/") && !SDK_ENTRIES.includes(imported)) return "deep SDK import";
  // Any path that lands in the SDK's package, however it is spelled.
  const target = imported.startsWith(".") ? resolve(ROOT, dirname(file), imported) : resolve(imported);
  if ((imported.startsWith(".") || imported.startsWith("/") || /^[A-Za-z]:/.test(imported)) && (target === SDK_DIR || target.startsWith(SDK_DIR + sep))) {
    return "path into the SDK's package";
  }
  if (/(^|\/)sdk\/(src|tests|package\.json)/.test(imported)) return "path into the SDK's package";
  // The layering below is the app's own; tests may load what they test.
  if (!file.startsWith("src/")) return null;
  const area = file.split("/")[1];
  if (area === "renderer" || area === "shared") {
    if (imported.startsWith("node:") || imported === "electron") return "Node or Electron in the browser side";
    if (imported === "gptimgsdk") return "the SDK's runtime in the browser side";
    if (/\/(main|preload)\//.test(imported)) return "main-side module in the browser side";
  }
  // Only the utility process loads the SDK: its entry and the op table it runs.
  const worker = file.endsWith("sdk-worker.ts") || file.endsWith("sdk-ops.ts");
  if (area === "main" && imported === "gptimgsdk" && !worker) return "the SDK loaded outside its worker";
  if (area === "main" && imported.endsWith("/sdk-ops.ts") && !worker) return "the SDK's op table loaded outside its worker";
  if (area === "preload" && imported !== "electron" && !imported.includes("/shared/")) return "preload reaching beyond electron and shared";
  return null;
}

describe("import boundaries", () => {
  it("finds a planted violation", () => {
    expect(specifiers('import { x } from "node:fs";\nimport type { Y } from "gptimgsdk/types";\nexport * from "./z.ts";\nconst y = await import("gptimgsdk");')).toEqual([
      "node:fs",
      "gptimgsdk/types",
      "./z.ts",
      "gptimgsdk",
    ]);
    expect(violations("src/renderer/src/App.tsx", "node:fs")).not.toBeNull();
    expect(violations("src/main/index.ts", "gptimgsdk")).not.toBeNull();
    expect(violations("src/main/index.ts", "./sdk-ops.ts")).not.toBeNull();
    expect(violations("src/main/sdk-worker.ts", "gptimgsdk/src/verbs/chat.ts")).not.toBeNull();
    expect(violations("tests/main/export.test.ts", "../../sdk/src/errors.ts")).not.toBeNull();
    expect(violations("tests/helpers/in-process-host.ts", "../../sdk/package.json")).not.toBeNull();
    expect(violations("src/main/index.ts", "../../sdk/src/index.ts")).not.toBeNull();
    expect(violations("tests/main/turn-sdk.test.ts", "gptimgsdk/testing")).toBeNull();
    expect(violations("tests/main/turn-sdk.test.ts", "gptimgsdk")).toBeNull();
  });

  it("holds across the app's source and tests", () => {
    const found: string[] = [];
    const sources = [...files("src"), ...files("tests")];
    expect(sources.length).toBeGreaterThan(40);
    for (const file of sources) {
      const rel = relative(ROOT, join(ROOT, file));
      for (const imported of specifiers(readFileSync(join(ROOT, file), "utf8"))) {
        const problem = violations(rel, imported);
        if (problem) found.push(`${rel}: ${imported} (${problem})`);
      }
    }
    expect(found).toEqual([]);
  });
});
