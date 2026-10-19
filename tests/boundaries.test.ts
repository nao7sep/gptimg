// Which code may import what: the renderer never reaches Node, Electron or the
// main side; only the SDK's worker loads the SDK itself; nothing reaches into
// the SDK's files. Derived from the source tree, with a planted violation.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("..", import.meta.url).pathname;

function files(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

/** Every module specifier a source imports or re-exports, static or dynamic. */
export function specifiers(source: string): string[] {
  const found: string[] = [];
  const patterns = [/\b(?:import|export)\s[^"'`;]*?from\s*["']([^"']+)["']/g, /\bimport\s*["']([^"']+)["']/g, /\bimport\(\s*["']([^"']+)["']\s*\)/g];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) found.push(match[1]!);
  return found;
}

function violations(file: string, imported: string): string | null {
  const area = file.split("/")[1];
  if (imported.startsWith("gptimgsdk/") && imported !== "gptimgsdk/types") return "deep SDK import";
  if (imported.includes("sdk/src")) return "SDK source import";
  if (area === "renderer" || area === "shared") {
    if (imported.startsWith("node:") || imported === "electron") return "Node or Electron in the browser side";
    if (imported === "gptimgsdk") return "the SDK's runtime in the browser side";
    if (/\/(main|preload)\//.test(imported)) return "main-side module in the browser side";
  }
  if (area === "main" && imported === "gptimgsdk" && !file.endsWith("sdk-worker.ts")) return "the SDK loaded outside its worker";
  if (area === "preload" && imported !== "electron" && !imported.includes("/shared/")) return "preload reaching beyond electron and shared";
  return null;
}

describe("import boundaries", () => {
  it("finds a planted violation", () => {
    expect(specifiers('import { x } from "node:fs";\nconst y = await import("gptimgsdk");')).toEqual(["node:fs", "gptimgsdk"]);
    expect(violations("src/renderer/src/App.tsx", "node:fs")).not.toBeNull();
    expect(violations("src/main/index.ts", "gptimgsdk")).not.toBeNull();
    expect(violations("src/main/sdk-worker.ts", "gptimgsdk/src/verbs/chat.ts")).not.toBeNull();
  });

  it("holds across the app's source", () => {
    const found: string[] = [];
    const sources = files("src");
    expect(sources.length).toBeGreaterThan(20);
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
