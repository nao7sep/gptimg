import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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

  it("releases the model within the upscale export's task, keeping the export successful when the model will not unload", async () => {
    const ops: string[] = [];
    const testRecords = { ...records, log: vi.fn() } as unknown as Records;
    const host = { call: (op: string) => {
      ops.push(op);
      return {
        done: Promise.resolve(op === "modelRelease"
          ? { kind: "error", error: { name: "GptImgError", code: "internal.unexpected", kind: "internal", effect: "unknown", message: "native release failed" } }
          : { kind: "result", result: { status: "completed", output: "/out/fox.png" } }),
        cancel() {},
      };
    } } as unknown as SdkHost;
    const exports = new ExportRunner({ host, records: testRecords, app: { name: "GptImg", version: "0" }, progress() {} });
    const outcome = await exports.export({ ...defaultExportPrefs(), path: "/s/fox.png", size: { kind: "upscale", factor: 2 } }, info, "/out/fox.png");
    expect(outcome).toEqual({ ok: true, value: "/out/fox.png" });
    expect(ops).toEqual(["upscale", "modelRelease"]);
    expect(testRecords.log).toHaveBeenCalledWith("warn", "model.releaseFailed", { failure: expect.objectContaining({ retryable: true }) });
    expect(exports.busy).toBe(false);
  });

  it("cancels the running task and settles once it has ended", async () => {
    let finish!: (value: CallSettlement) => void;
    let cancelled = false;
    const host = { call: () => ({
      done: new Promise<CallSettlement>((resolve) => (finish = resolve)),
      cancel: () => { cancelled = true; },
    }) } as unknown as SdkHost;
    const exports = new ExportRunner({ host, records, app: { name: "GptImg", version: "0" }, progress() {} });
    const running = exports.installUpscaler();
    expect(exports.busy).toBe(true);
    await expect(exports.installUpscaler()).resolves.toMatchObject({ ok: false, failure: { message: { key: "failure.taskRunning" } } });
    let settled = false;
    const cancelling = exports.cancel().then(() => { settled = true; });
    expect(cancelled).toBe(true);
    await Promise.resolve();
    expect(settled).toBe(false);
    finish({ kind: "error", error: { name: "GptImgError", code: "cancelled", kind: "cancelled", effect: "none", message: "x" } });
    await cancelling;
    await expect(running).resolves.toMatchObject({ ok: false, cancelled: true });
    expect(exports.busy).toBe(false);
  });

  it.each([false, true])("reports the model's installed state as %s after a successful status check", async (cached) => {
    const t = runner(() => ({ kind: "result", result: { status: "completed", models: [{ key: "swin2sr", cached, downloadBytes: 53_827_735 }] } }));
    expect(await t.exports.upscalerStatus()).toEqual({ installed: cached, downloadBytes: 53_827_735 });
  });

  it("preserves an unsuccessful status check instead of presenting a missing model", async () => {
    const t = runner(() => ({ kind: "error", error: { name: "GptImgError", code: "fs.permissionDenied", kind: "unavailable", effect: "none", message: "private diagnostic" } }));
    expect(await t.exports.upscalerStatus()).toEqual({ installed: false, downloadBytes: null, failure: { message: { key: "failure.filePermission" }, retryable: true } });
  });

  it("preserves a lost worker while checking the model", async () => {
    const t = runner(() => ({ kind: "lost" }));
    expect(await t.exports.upscalerStatus()).toEqual({ installed: false, downloadBytes: null, failure: { message: { key: "failure.workerLost" }, retryable: true } });
  });
});
