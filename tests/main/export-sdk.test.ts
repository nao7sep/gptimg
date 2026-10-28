// Exports through the real SDK, not a scripted one: a call option the export
// runner hands every verb must be one every verb takes, or every export and
// the upscaler's download fail.
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GptImg } from "gptimgsdk";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { ExportRunner } from "../../src/main/export.ts";
import type { Records } from "../../src/main/records.ts";
import { defaultExportPrefs } from "../../src/shared/export.ts";


const events: Record<string, unknown>[] = [];
const records = { sessionId: "w", log() {}, sdkEvent: (_id: unknown, event: Record<string, unknown>) => events.push(event), turn() {}, close() {} } as unknown as Records;

describe("exports through the real SDK", () => {
  let source: string;
  beforeAll(async () => {
    source = join(mkdtempSync(join(tmpdir(), "gptimg-export-src-")), "fox.png");
    await sharp({ create: { width: 64, height: 32, channels: 3, background: "#c06030" } }).png().toFile(source);
  });

  function runner() {
    return new ExportRunner({ sdk: new GptImg({ app: { name: "GptImg", version: "test" } }), records, progress() {} });
  }

  it("inspects and exports an image", async () => {
    const exports = runner();
    const info = await exports.inspect(source);
    if (!info.ok) throw new Error(JSON.stringify(info.failure));
    expect(info.value).toMatchObject({ width: 64, height: 32, format: "png" });
    const target = join(mkdtempSync(join(tmpdir(), "gptimg-export-out-")), "fox.jpg");
    const outcome = await exports.export({ ...defaultExportPrefs(), format: "jpeg", path: source }, info.value, target);
    expect(outcome).toEqual({ ok: true, value: target });
    expect((await sharp(target).metadata()).format).toBe("jpeg");
    expect(events.some((event) => event.event === "verb.done")).toBe(true);
  });

  it("reports the upscaler's status", async () => {
    const status = await runner().upscalerStatus();
    expect(typeof status.installed).toBe("boolean");
    expect(existsSync(source)).toBe(true);
  });
});
