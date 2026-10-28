import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GptImgError, type VerbCallOptions } from "gptimgsdk";
import { ExportRunner, type ExportDeps } from "../../src/main/export.ts";
import type { Records } from "../../src/main/records.ts";
import { defaultExportPrefs } from "../../src/shared/export.ts";

const records = { sessionId: "l", log() {}, sdkEvent() {}, turn() {}, close() {} } as unknown as Records;
const info = { width: 100, height: 50, format: "png", fileBytes: 10, transparent: false };

type Answer = (op: string, args: Record<string, unknown>, options: VerbCallOptions) => unknown;

/** A scripted SDK: each verb records its call, reports one progress step and answers, or throws, as `answer` does. */
function fakeSdk(answer: Answer) {
  const calls: { op: string; args: Record<string, unknown> }[] = [];
  const verb = (op: string) => async (args: Record<string, unknown> = {}, options: VerbCallOptions = {}) => {
    calls.push({ op, args });
    options.onProgress?.({ verb: "upscale", stage: "infer", done: 1, total: 2, unit: "tiles" });
    return answer(op, args, options);
  };
  const sdk = {
    inspect: verb("inspect"),
    encode: verb("encode"),
    resize: verb("resize"),
    upscale: verb("upscale"),
    model: { list: verb("modelList"), install: verb("modelInstall"), release: verb("modelRelease") },
  } as unknown as ExportDeps["sdk"];
  return { sdk, calls };
}

function runner(answer: Answer, deps: Partial<ExportDeps> = {}) {
  const { sdk, calls } = fakeSdk(answer);
  const progress: unknown[] = [];
  const exports = new ExportRunner({ sdk, records, progress: (p) => progress.push(p), ...deps });
  return { exports, calls, progress };
}

describe("export", () => {
  it("has the SDK write the chosen file itself, replacing it as the user agreed", async () => {
    const t = runner((_op, args) => {
      writeFileSync(String(args.out), "jpeg-bytes");
      return { status: "completed", output: args.out };
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
    const t = runner((_op, args) => ({ status: "completed", output: args.out }));
    const outcome = await t.exports.export({ ...defaultExportPrefs(), format: "webp", path: "/s/fox.png" }, info, "/out/fox.png");
    expect(outcome).toEqual({ ok: true, value: "/out/fox.png.webp" });
    expect(t.calls[0]!.args).toMatchObject({ out: "/out/fox.png.webp", overwrite: false });
  });

  it("leaves the chosen file alone when the SDK refuses", async () => {
    const t = runner(() => { throw new GptImgError("image.notOpaque", "x"); });
    const target = join(mkdtempSync(join(tmpdir(), "gptimg-target-")), "fox.jpg");
    const outcome = await t.exports.export({ ...defaultExportPrefs(), format: "jpeg", path: "/s/fox.png" }, info, target);
    expect(outcome).toMatchObject({ ok: false, failure: { message: { key: "failure.needsFill" } }, cancelled: false });
    expect(existsSync(target)).toBe(false);
  });

  it("releases the model within the upscale export's task, keeping the export successful when the model will not unload", async () => {
    const testRecords = { ...records, log: vi.fn() } as unknown as Records;
    const { exports, calls } = runner((op) => {
      if (op === "modelRelease") throw new GptImgError("internal.unexpected", "native release failed");
      return { status: "completed", output: "/out/fox.png" };
    }, { records: testRecords });
    const outcome = await exports.export({ ...defaultExportPrefs(), path: "/s/fox.png", size: { kind: "upscale", factor: 2 } }, info, "/out/fox.png");
    expect(outcome).toEqual({ ok: true, value: "/out/fox.png" });
    expect(calls.map((c) => c.op)).toEqual(["upscale", "modelRelease"]);
    expect(testRecords.log).toHaveBeenCalledWith("warn", "model.releaseFailed", { failure: expect.objectContaining({ retryable: true }) });
    expect(exports.busy).toBe(false);
  });

  it("cancels the running task and settles once it has ended", async () => {
    let finish!: () => void;
    let cancelled = false;
    const { exports } = runner((_op, _args, options) => {
      options.signal!.addEventListener("abort", () => { cancelled = true; });
      return new Promise((_resolve, reject) => (finish = () => reject(new GptImgError("cancelled", "x"))));
    });
    const running = exports.installUpscaler();
    expect(exports.busy).toBe(true);
    await expect(exports.installUpscaler()).resolves.toMatchObject({ ok: false, failure: { message: { key: "failure.taskRunning" } } });
    let settled = false;
    const cancelling = exports.cancel().then(() => { settled = true; });
    expect(cancelled).toBe(true);
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await cancelling;
    await expect(running).resolves.toMatchObject({ ok: false, cancelled: true });
    expect(exports.busy).toBe(false);
  });

  it.each([false, true])("reports the model's installed state as %s after a successful status check", async (cached) => {
    const t = runner(() => ({ status: "completed", models: [{ key: "swin2sr", cached, downloadBytes: 53_827_735 }] }));
    expect(await t.exports.upscalerStatus()).toEqual({ installed: cached, downloadBytes: 53_827_735 });
  });

  it("preserves an unsuccessful status check instead of presenting a missing model", async () => {
    const t = runner(() => { throw new GptImgError("fs.permissionDenied", "private diagnostic"); });
    expect(await t.exports.upscalerStatus()).toEqual({ installed: false, downloadBytes: null, failure: { message: { key: "failure.filePermission" }, retryable: true } });
  });
});
