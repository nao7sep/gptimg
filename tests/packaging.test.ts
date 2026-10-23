import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("declares a macOS minimum compatible with the bundled ONNX Runtime library", () => {
  const config = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");
  const mac = /^mac:\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m.exec(config)?.[1] ?? "";
  const version = /^  minimumSystemVersion:\s*["']?(\d+(?:\.\d+)*)["']?\s*$/m.exec(mac)?.[1];
  expect(version, "the bundle must declare its native runtime's OS requirement").toBeDefined();
  expect(Number(version!.split(".")[0]), "ONNX Runtime requires macOS 14 or later").toBeGreaterThanOrEqual(14);
});
