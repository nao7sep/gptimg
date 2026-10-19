// The package boundary held by a test, not discipline (sdk-conventions, *Held by
// tests*): a syntax-tree scan of every source file fails on an import from
// outside the package other than Node builtins and declared dependencies, on any
// read of the process environment or working directory, on standard stream
// output, on the home or temp folder outside the one module that derives the
// SDK's own resource defaults, and on an error or refusal code missing from its
// table. A planted violation of each rule proves the scan can fail.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "../../src/errors.ts";
import { REFUSAL_CODES } from "../../src/refusal.ts";

const PACKAGE = fileURLToPath(new URL("../../", import.meta.url));
const SRC = path.join(PACKAGE, "src");
const RESOURCE_HOME = path.join("src", "internal", "resource-home.ts");
const manifest = JSON.parse(readFileSync(path.join(PACKAGE, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
};
const DEPENDENCIES = new Set(Object.keys(manifest.dependencies));

interface Node {
  type: string;
  name?: string;
  value?: string;
  [key: string]: unknown;
}

function* walk(node: unknown): Generator<Node> {
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
    return;
  }
  if (!node || typeof node !== "object" || typeof (node as Node).type !== "string") return;
  yield node as Node;
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "leadingComments" || key === "trailingComments") continue;
    if (value && typeof value === "object") yield* walk(value);
  }
}

const isIdent = (node: unknown, name: string): boolean =>
  !!node && (node as Node).type === "Identifier" && (node as Node).name === name;

function memberName(node: Node): [string, string] | null {
  if (node.type !== "MemberExpression" || (node as { computed?: boolean }).computed) return null;
  const object = node.object as Node;
  const property = node.property as Node;
  if (object.type !== "Identifier" || property.type !== "Identifier") return null;
  return [object.name!, property.name!];
}

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** Every boundary violation in `code`, read as the package file `file` (relative to the package). */
export function scanSource(code: string, file: string): string[] {
  const ast = parse(code, { sourceType: "module", plugins: ["typescript"] });
  const found: string[] = [];
  const homeAllowed = file === RESOURCE_HOME;
  for (const node of walk(ast.program)) {
    const source =
      node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration"
        ? (node.source as { value?: string } | null)?.value
        : node.type === "ImportExpression"
          ? ((node.source as Node).type === "StringLiteral" ? (node.source as Node).value : undefined)
          : undefined;
    if (typeof source === "string") {
      if (source.startsWith(".")) {
        const target = path.normalize(path.join(path.dirname(file), source));
        if (!target.startsWith(`src${path.sep}`)) found.push(`import outside the package: ${source}`);
      } else if (!source.startsWith("node:") && !DEPENDENCIES.has(packageName(source))) {
        found.push(`import of an undeclared package: ${source}`);
      }
      if (source === "node:os" && !homeAllowed) {
        for (const spec of (node.specifiers as Node[] | undefined) ?? []) {
          const imported = (spec as { imported?: { name?: string } }).imported?.name;
          if (imported === "homedir" || imported === "tmpdir") found.push(`${imported} imported outside the resource-default module`);
        }
      }
    }
    const member = memberName(node);
    if (member) {
      const [object, property] = member;
      if (object === "process" && property === "env") found.push("process.env read");
      if (object === "process" && (property === "stdout" || property === "stderr")) found.push(`process.${property} use`);
      if (object === "process" && property === "cwd") found.push("process.cwd read");
      if (object === "console") found.push(`console.${property} use`);
      if ((property === "homedir" || property === "tmpdir") && !homeAllowed) found.push(`${object}.${property} use outside the resource-default module`);
    }
    if (node.type === "CallExpression") {
      const callee = node.callee as Node;
      const args = node.arguments as Node[];
      const calleeMember = memberName(callee);
      if (calleeMember && calleeMember[0] === "path" && calleeMember[1] === "resolve" && args.length < 2) {
        found.push("single-argument path.resolve, which reads the working directory");
      }
      const first = args[0];
      const literal = first?.type === "StringLiteral" ? first.value : undefined;
      if (isIdent(callee, "refuse") && literal !== undefined && !(REFUSAL_CODES as readonly string[]).includes(literal)) {
        found.push(`refusal code not in REFUSAL_CODES: ${literal}`);
      }
    }
    if (node.type === "NewExpression" && isIdent(node.callee, "GptImgError")) {
      const first = (node.arguments as Node[])[0];
      if (first?.type === "StringLiteral" && !Object.hasOwn(ERROR_CODES, first.value!)) {
        found.push(`error code not in ERROR_CODES: ${first.value}`);
      }
    }
  }
  return found;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

/** The modules a value import of `entry` loads, following relative imports and skipping type-only ones. */
function runtimeImports(entry: string, seen = new Set<string>()): { files: Set<string>; packages: Set<string> } {
  const packages = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const ast = parse(readFileSync(file, "utf8"), { sourceType: "module", plugins: ["typescript"] });
    for (const node of ast.program.body as unknown as Node[]) {
      const isModuleLink = node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration";
      const source = isModuleLink ? (node.source as { value?: string } | null)?.value : undefined;
      if (typeof source !== "string") continue;
      const kind = (node as { importKind?: string; exportKind?: string }).importKind ?? (node as { exportKind?: string }).exportKind;
      if (kind === "type") continue;
      if (source.startsWith(".")) visit(path.join(path.dirname(file), source));
      else packages.add(source);
    }
  };
  visit(entry);
  return { files: seen, packages };
}

describe("the package boundary", () => {
  it("holds in every source file", () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(50);
    const violations = files.flatMap((full) => {
      const file = path.relative(PACKAGE, full);
      return scanSource(readFileSync(full, "utf8"), file).map((v) => `${file}: ${v}`);
    });
    expect(violations).toEqual([]);
  });

  it("catches a planted violation of every rule", () => {
    const planted = [
      'import { helper } from "../../outside/helper.ts";',
      'import vitest from "vitest";',
      'import { homedir, tmpdir } from "node:os";',
      'import os from "node:os";',
      'import path from "node:path";',
      'import { GptImgError } from "../errors.ts";',
      'import { refuse } from "../refusal.ts";',
      "const key = process.env.OPENAI_API_KEY;",
      "const here = process.cwd();",
      'process.stdout.write("x");',
      'console.log("x");',
      "const home = os.homedir();",
      'const local = path.resolve("relative");',
      'throw new GptImgError("made.up", "x");',
      'refuse("output.invented", "x");',
    ].join("\n");
    expect(scanSource(planted, path.join("src", "verbs", "planted.ts"))).toEqual([
      "import outside the package: ../../outside/helper.ts",
      "import of an undeclared package: vitest",
      "homedir imported outside the resource-default module",
      "tmpdir imported outside the resource-default module",
      "process.env read",
      "process.cwd read",
      "process.stdout use",
      "console.log use",
      "os.homedir use outside the resource-default module",
      "single-argument path.resolve, which reads the working directory",
      "error code not in ERROR_CODES: made.up",
      "refusal code not in REFUSAL_CODES: output.invented",
    ]);
  });

  it("keeps the gptimgsdk/types entry free of every package and Node builtin, so a renderer can load it", () => {
    const { files, packages } = runtimeImports(path.join(SRC, "types.ts"));
    expect([...packages]).toEqual([]);
    expect(files.size).toBeGreaterThan(1);
    // The same walk over the full entry finds its native and network dependencies, so it can fail.
    const full = [...runtimeImports(path.join(SRC, "index.ts")).packages];
    expect(full).toEqual(expect.arrayContaining(["sharp", "openai"]));
    // ONNX Runtime loads on the first inference, so a consumer that never runs a local model need not ship it.
    expect(full).not.toContain("onnxruntime-node");
  });

  it("allows the home folder only in the resource-default module", () => {
    const code = 'import { homedir } from "node:os";\nexport const d = homedir();';
    expect(scanSource(code, RESOURCE_HOME)).toEqual([]);
    expect(scanSource(code, path.join("src", "context.ts"))).toEqual(["homedir imported outside the resource-default module"]);
  });
});
