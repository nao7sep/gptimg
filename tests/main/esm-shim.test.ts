// electron-vite gives every main-process bundle its own top-level `__dirname`
// and `__filename`, so a bundled module that declares either makes the bundle a
// syntax error at load: the app fails to start while the tests, which never load
// the bundle, still pass. Modules use `import.meta.dirname` instead. The main
// bundle takes in the main process's modules, the shared ones and the SDK.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const BUNDLED = ["src/main", "src/shared", "sdk/src"];
const SHIMMED = new Set(["__dirname", "__filename"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|mts)$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [full] : [];
  });
}

/** The shim names a module declares at its top level, where they would clash with electron-vite's. */
function declaredShims(source: string): string[] {
  const ast = parse(source, { sourceType: "module", plugins: ["typescript", "importAttributes"] });
  const found: string[] = [];
  for (const statement of ast.program.body) {
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations) {
        if (declarator.id.type === "Identifier" && SHIMMED.has(declarator.id.name)) found.push(declarator.id.name);
      }
    }
    if ((declaration?.type === "FunctionDeclaration" || declaration?.type === "ClassDeclaration") && declaration.id && SHIMMED.has(declaration.id.name)) {
      found.push(declaration.id.name);
    }
    if (statement.type === "ImportDeclaration") {
      for (const specifier of statement.specifiers) if (SHIMMED.has(specifier.local.name)) found.push(specifier.local.name);
    }
  }
  return found;
}

describe("bundled modules and electron-vite's shims", () => {
  it("declare no __dirname or __filename of their own", () => {
    const offenders = BUNDLED.flatMap((dir) => sourceFiles(join(ROOT, dir))).flatMap((file) =>
      declaredShims(readFileSync(file, "utf8")).map((name) => `${relative(ROOT, file)}: ${name}`),
    );
    expect(offenders).toEqual([]);
  });

  it("finds such a declaration", () => {
    expect(declaredShims('import { fileURLToPath } from "node:url";\nconst __dirname = fileURLToPath(new URL(".", import.meta.url));\nexport const value = __dirname;')).toEqual(["__dirname"]);
    expect(declaredShims("export function __filename() {}")).toEqual(["__filename"]);
  });
});
