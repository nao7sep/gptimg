// Exports through the real worker module, not a stand-in host: a call option
// the worker hands every op must be one every verb takes, or every export and
// the upscaler's download fail.
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { ExportRunner } from "../../src/main/export.ts";
import type { Records } from "../../src/main/records.ts";
import type { SdkHost } from "../../src/main/sdk-host.ts";
import { defaultExportPrefs } from "../../src/shared/export.ts";
import { workerHost } from "../helpers/worker-host.ts";

const events: Record<string, unknown>[] = [];
const records = { sessionId: "w", log() {}, sdkEvent: (_id: unknown, event: Record<string, unknown>) => events.push(event), turn() {}, close() {} } as unknown as Records;

describe("the SDK worker", () => {
  let host: SdkHost;
  let source: string;
  beforeAll(async () => {
    host = await workerHost();
    source = join(mkdtempSync(join(tmpdir(), "gptimg-worker-src-")), "fox.png");
    await sharp({ create: { width: 64, height: 32, channels: 3, background: "#c06030" } }).png().toFile(source);
  });

  function runner() {
    return new ExportRunner({ host, records, app: { name: "GptImg", version: "test" }, progress() {} });
  }

  it("inspects and exports an image", async () => {
    const exports = runner();
    const info = await exports.inspect(source);
    if (!info.ok) throw new Error(JSON.stringify(info.failure));
    expect(info.value).toMatchObject({ width: 64, height: 32, format: "png" });
    const target = join(mkdtempSync(join(tmpdir(), "gptimg-worker-out-")), "fox.jpg");
    const outcome = await exports.export({ ...defaultExportPrefs(), format: "jpeg", path: source }, info.value, target);
    expect(outcome).toEqual({ ok: true, value: target });
    expect((await sharp(target).metadata()).format).toBe("jpeg");
    expect(events.some((event) => event.event === "verb.done")).toBe(true);
  });

  it("reports the upscaler's status and releases models", async () => {
    const status = await runner().upscalerStatus();
    expect(typeof status.installed).toBe("boolean");
    const released = await host.call("modelRelease", { name: "GptImg", version: "test" }, {}, {}).done;
    expect(released).toMatchObject({ kind: "result", result: { status: "completed" } });
    expect(existsSync(source)).toBe(true);
  });
});
