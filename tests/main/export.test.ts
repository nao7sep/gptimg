import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExportRunner } from "../../src/main/export.ts";
import type { Records } from "../../src/main/records.ts";
import type { CallSettlement, SdkHost } from "../../src/main/sdk-host.ts";
import { defaultExportPrefs } from "../../src/shared/export.ts";

const records = { sessionId: "l", log() {}, sdkEvent() {}, turn() {}, close() {} } as unknown as Records;
const info = { width: 100, height: 50, format: "png", fileBytes: 10, transparent: false };

function runner(answer: (op: string, args: Record<string, unknown>) => CallSettlement) {
  const staging = mkdtempSync(join(tmpdir(), "gptimg-export-"));
  const calls: { op: string; args: Record<string, unknown> }[] = [];
  const host = {
    call(op: string, _app: unknown, args: Record<string, unknown>, hooks: { onProgress?: (p: Record<string, unknown>) => void }) {
      calls.push({ op, args });
      hooks.onProgress?.({ stage: "infer", done: 1, total: 2, unit: "tiles" });
      return { id: "c", done: Promise.resolve(answer(op, args)), cancel() {} };
    },
  } as unknown as SdkHost;
  const progress: unknown[] = [];
  const exports = new ExportRunner({ host, records, app: { name: "GptImg", version: "0" }, stagingRoot: staging, progress: (p) => progress.push(p) });
  return { exports, calls, progress, staging };
}

describe("export", () => {
  it("makes the file in staging, puts it where the user chose and leaves no staging behind", async () => {
    const t = runner((_op, args) => {
      const output = join(String(args.outDir), "export.jpg");
      writeFileSync(output, "jpeg-bytes");
      return { kind: "result", result: { status: "completed", output } };
    });
    const target = join(mkdtempSync(join(tmpdir(), "gptimg-target-")), "fox.jpg");
    writeFileSync(target, "older");
    const outcome = await t.exports.export({ ...defaultExportPrefs(), format: "jpeg", path: "/s/fox.png" }, info, target);
    expect(outcome).toEqual({ ok: true, value: target });
    expect(readFileSync(target, "utf8")).toBe("jpeg-bytes");
    expect(t.calls[0]!.op).toBe("encode");
    expect(t.progress).toEqual([{ task: "export", stage: "infer", done: 1, total: 2, unit: "tiles" }]);
    expect(readdirSync(t.staging)).toEqual([]);
  });

  it("leaves the chosen file alone when the SDK refuses", async () => {
    const t = runner(() => ({ kind: "error", error: { name: "GptImgError", code: "image.notOpaque", kind: "invalid", effect: "none", message: "x" } }));
    const target = join(mkdtempSync(join(tmpdir(), "gptimg-target-")), "fox.jpg");
    const outcome = await t.exports.export({ ...defaultExportPrefs(), format: "jpeg", path: "/s/fox.png" }, info, target);
    expect(outcome).toMatchObject({ ok: false, failure: { message: { key: "failure.needsFill" } }, cancelled: false });
    expect(existsSync(target)).toBe(false);
  });

  it("reports whether the upscaling model is installed", async () => {
    const t = runner(() => ({ kind: "result", result: { status: "completed", models: [{ key: "swin2sr", cached: false, downloadBytes: 53_827_735 }] } }));
    expect(await t.exports.upscalerStatus()).toEqual({ installed: false, downloadBytes: 53_827_735 });
  });
});
