import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExportRunner } from "../../src/main/export.ts";
import type { Records } from "../../src/main/records.ts";
import type { CallSettlement, SdkHost } from "../../src/main/sdk-host.ts";
import { defaultExportPrefs } from "../../src/shared/export.ts";

const records = { sessionId: "l", log() {}, sdkEvent() {}, turn() {}, close() {} } as unknown as Records;
const info = { width: 100, height: 50, format: "png", fileBytes: 10, transparent: false };

function runner(answer: (op: string, args: Record<string, unknown>) => CallSettlement) {
  const calls: { op: string; args: Record<string, unknown> }[] = [];
  const host = {
    call(op: string, _app: unknown, args: Record<string, unknown>, hooks: { onProgress?: (p: Record<string, unknown>) => void }) {
      calls.push({ op, args });
      hooks.onProgress?.({ stage: "infer", done: 1, total: 2, unit: "tiles" });
      return { id: "c", done: Promise.resolve(answer(op, args)), cancel() {} };
    },
  } as unknown as SdkHost;
  const progress: unknown[] = [];
  const exports = new ExportRunner({ host, records, app: { name: "GptImg", version: "0" }, progress: (p) => progress.push(p) });
  return { exports, calls, progress };
}

describe("export", () => {
  it("has the SDK write the chosen file itself, replacing it as the user agreed", async () => {
    const t = runner((_op, args) => {
      writeFileSync(String(args.out), "jpeg-bytes");
      return { kind: "result", result: { status: "completed", output: args.out } };
    });
    const target = join(mkdtempSync(join(tmpdir(), "gptimg-target-")), "fox.jpg");
    writeFileSync(target, "older");
    const outcome = await t.exports.export({ ...defaultExportPrefs(), format: "jpeg", path: "/s/fox.png" }, info, target);
    expect(outcome).toEqual({ ok: true, value: target });
    expect(readFileSync(target, "utf8")).toBe("jpeg-bytes");
    expect(t.calls[0]).toMatchObject({ op: "encode", args: { out: target, overwrite: true } });
    expect(t.progress).toEqual([{ task: "export", stage: "infer", done: 1, total: 2, unit: "tiles" }]);
    expect(readdirSync(dirname(target))).toEqual(["fox.jpg"]);
  });

  it("adds the format's extension to a name typed past the dialog's filter, without replacing a file there", async () => {
    const t = runner((_op, args) => ({ kind: "result", result: { status: "completed", output: args.out } }));
    const outcome = await t.exports.export({ ...defaultExportPrefs(), format: "webp", path: "/s/fox.png" }, info, "/out/fox.png");
    expect(outcome).toEqual({ ok: true, value: "/out/fox.png.webp" });
    expect(t.calls[0]!.args).toMatchObject({ out: "/out/fox.png.webp", overwrite: false });
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
