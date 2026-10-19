// The SDK's events: complete records handed to onEvent, with nothing written
// anywhere. The message is fixed by the event's name, credentials are masked,
// debug events are gated, and a failing hook never breaks the call.
import { mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/events/index.ts";
import { GptImg, VERSION } from "../../src/index.ts";
import type { ProgressUpdate, SdkEvent } from "../../src/types.ts";
import { captureStderr } from "../helpers/streams.ts";

const execFileAsync = promisify(execFile);

describe("createLogger", () => {
  it("stamps each event with time, level, stage, verb and the message fixed by its name", () => {
    const seen: SdkEvent[] = [];
    const logger = createLogger("trim", { onEvent: (e) => seen.push(e) });
    logger.emit("info", "write", { event: "verb.done", output: "/out.png", stats: { width: 4 } });
    expect(seen).toEqual([
      {
        time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
        level: "info",
        stage: "write",
        verb: "trim",
        message: "verb finished",
        event: "verb.done",
        output: "/out.png",
        stats: { width: 4 },
      },
    ]);
  });

  it("masks every registered credential in every string field without corrupting other values", () => {
    const seen: SdkEvent[] = [];
    const logger = createLogger("generate", { onEvent: (e) => seen.push(e) });
    logger.addCredential("sk-q");
    logger.emit("info", "request", {
      event: "provider.call",
      operation: "generate",
      model: "m",
      settings: { url: "https://x.test/?token=sk-q&n=1", count: 12, flag: true, quote: 'a"sk-q"b' },
    });
    expect(seen[0]).toMatchObject({
      settings: { url: "https://x.test/?token=[REDACTED]&n=1", count: 12, flag: true, quote: 'a"[REDACTED]"b' },
    });
  });

  it("drops debug events unless debug is on", () => {
    const quiet: SdkEvent[] = [];
    const loud: SdkEvent[] = [];
    const body = { event: "chat.historyImage", path: "/a.png", width: 1, height: 1, format: "png" } as const;
    createLogger("chat", { onEvent: (e) => quiet.push(e) }).emit("debug", "request", body);
    createLogger("chat", { onEvent: (e) => loud.push(e), debug: true }).emit("debug", "request", body);
    expect(quiet).toEqual([]);
    expect(loud).toHaveLength(1);
  });

  it("contains a throwing hook and an unserializable event", () => {
    const logger = createLogger("mask", { onEvent: () => { throw new Error("sink blew up"); } });
    expect(() => logger.emit("info", "resolve", { event: "verb.start", input: null, output: null, settings: {} })).not.toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const seen: SdkEvent[] = [];
    const quiet = createLogger("mask", { onEvent: (e) => seen.push(e) });
    expect(() => quiet.emit("info", "resolve", { event: "verb.start", input: null, output: null, settings: cyclic })).not.toThrow();
    expect(seen).toEqual([]);
  });

  it("reports countable work to onProgress, throttled, always with the final count", () => {
    const updates: ProgressUpdate[] = [];
    const logger = createLogger("upscale", { onProgress: (u) => updates.push(u) });
    for (let i = 1; i <= 50; i++) logger.progress("infer", i, 50, "tiles");
    expect(updates.length).toBeLessThan(50);
    expect(updates.at(-1)).toEqual({ verb: "upscale", stage: "infer", done: 50, total: 50, unit: "tiles" });
  });
});

describe("events through the public verbs", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-events-"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tmp, { recursive: true, force: true });
  });

  it("sends one startup event per instance, to the first call that listens, with the version and configuration", async () => {
    const sdk = new GptImg({ apiKey: "sk-startup-secret", modelsDir: path.join(tmp, "models"), app: { name: "GptImg", version: "9.9.9" }, policy: { chat: { quality: "low" } } });
    const plate = (name: string) => ({ size: 8, from: "#ffffff", to: "#000000", outDir: tmp, outName: name });
    await sdk.backplate(plate("unwatched"));
    const first: SdkEvent[] = [];
    const second: SdkEvent[] = [];
    await sdk.backplate(plate("first"), { onEvent: (e) => first.push(e) });
    await sdk.backplate(plate("second"), { onEvent: (e) => second.push(e) });
    expect(first.map((e) => e.event)).toEqual(["sdk.start", "verb.start", "verb.done"]);
    expect(second.map((e) => e.event)).toEqual(["verb.start", "verb.done"]);
    expect(first[0]).toMatchObject({
      level: "info",
      stage: "startup",
      verb: "backplate",
      version: VERSION,
      node: process.versions.node,
      modelsDir: path.join(tmp, "models"),
      debug: false,
      app: { name: "GptImg", version: "9.9.9" },
      apiKey: true,
      policy: { chat: { quality: "low" } },
    });
    expect(JSON.stringify(first)).not.toContain("sk-startup-secret");
  });

  it("writes nothing but the verb's output, prints nothing, and refuses the retired log options", async () => {
    const stderr = await captureStderr(async () => {
      await new GptImg().backplate({ size: 8, from: "#ffffff", to: "#000000", outDir: tmp, outName: "only" }, { onEvent: () => {} });
    });
    expect(stderr.join("")).toBe("");
    expect(await readdir(tmp)).toEqual(["only.png"]);
    expect(() => new GptImg({ logDir: tmp } as never)).toThrow(expect.objectContaining({ code: "args.invalid", details: { field: "logDir", constraint: "retired" } }));
    await expect(new GptImg().backplate({ size: 8, from: "#ffffff", to: "#000000", outDir: tmp }, { log: { dir: tmp } } as never)).rejects.toMatchObject({
      code: "args.invalid",
      details: { field: "log", constraint: "retired" },
    });
  });

  it.each([
    ["async-progress", "a rejected async event hook leaves public peers successful"],
    ["thenable-progress", "a rejecting thenable event hook is observed and contained"],
    ["pending-progress", "an unresolved event hook never delays public operation settlement"],
  ])("%s: %s without process-global failures", async (scenario) => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      fileURLToPath(new URL("../helpers/progress-process.ts", import.meta.url)), scenario, tmp,
    ], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      // Exercise Node's default rejection policy rather than inheriting a
      // caller's NODE_OPTIONS that might suppress unhandled rejections.
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({ outputs: 2, events: 3 });
    if (scenario === "pending-progress") expect(JSON.parse(stdout).pendingAtFinish).toBe(true);
  });
});
