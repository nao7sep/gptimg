import { link, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { RefusalSignal, refuse } from "../../src/refusal.ts";
import { statSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertSingleFileAvailable,
  inferStem,
  resolveOutputPath,
  withVerbLogger,
} from "../../src/internal/local-verb.ts";
import { APIError } from "openai";
import { GptImgError } from "../../src/errors.ts";
import type { SdkContext } from "../../src/context.ts";
import type { SdkEvent, VerbName } from "../../src/types.ts";

describe("inferStem", () => {
  it("strips the final extension from a basename", () => {
    expect(inferStem("/a/b/foo.png")).toBe("foo");
    expect(inferStem("foo.png")).toBe("foo");
    expect(inferStem("/a/foo.tar.gz")).toBe("foo.tar");
  });

  it("returns the basename unchanged when there is no extension", () => {
    expect(inferStem("/tmp/README")).toBe("README");
  });

  it("treats a leading-dot filename as having no extension", () => {
    // path.basename(".env").lastIndexOf(".") === 0, which is not > 0.
    expect(inferStem("/x/.env")).toBe(".env");
  });
});

describe("assertSingleFileAvailable", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-lv-overwrite-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("allows writing when the target does not exist", () => {
    expect(() =>
      assertSingleFileAvailable(path.join(tmp, "nope.png"), false),
    ).not.toThrow();
  });

  it("throws output.exists when the target exists and overwrite is false", async () => {
    const target = path.join(tmp, "there.png");
    await writeFile(target, "x");
    expect(() => assertSingleFileAvailable(target, false)).toThrowError(
      RefusalSignal,
    );
    try {
      assertSingleFileAvailable(target, false);
    } catch (err) {
      expect((err as RefusalSignal).code).toBe("output.exists");
      expect((err as Error).message).toContain("overwrite: true");
    }
  });

  it("allows overwriting when overwrite is true", async () => {
    const target = path.join(tmp, "there.png");
    await writeFile(target, "x");
    expect(() => assertSingleFileAvailable(target, true)).not.toThrow();
  });

  it("blocks a case-differing existing file (Photo.png blocks photo.png)", async () => {
    await writeFile(path.join(tmp, "Photo.png"), "x");
    expect(() =>
      assertSingleFileAvailable(path.join(tmp, "photo.png"), false),
    ).toThrowError(RefusalSignal);
    try {
      assertSingleFileAvailable(path.join(tmp, "photo.png"), false);
    } catch (err) {
      expect((err as RefusalSignal).code).toBe("output.exists");
      expect((err as Error).message).toContain("Photo.png");
    }
  });

  it("refuses even under overwrite to replace a file whose name differs only in case", async () => {
    await writeFile(path.join(tmp, "Photo.png"), "x");
    expect(() => assertSingleFileAvailable(path.join(tmp, "photo.png"), true)).toThrow(
      expect.objectContaining({ code: "output.caseConflict", message: expect.stringContaining("Photo.png") }),
    );
  });

  it.each([
    ["cafe\u0301", "caf\u00e9"],
    ["caf\u00e9", "cafe\u0301"],
  ])("detects equivalent Unicode filenames and retains the case rule (%s against %s)", async (existing, planned) => {
    await writeFile(path.join(tmp, `${existing}.png`), "old image");
    const target = path.join(tmp, `${planned}.png`);
    expect(() => assertSingleFileAvailable(target, false)).toThrow(
      expect.objectContaining({ code: "output.exists" }),
    );
    const requestedSpelling = statSync(target, { throwIfNoEntry: false });
    const actualFile = statSync(path.join(tmp, `${existing}.png`));
    if (requestedSpelling?.ino === actualFile.ino && requestedSpelling.dev === actualFile.dev) {
      expect(() => assertSingleFileAvailable(target, true)).not.toThrow();
    } else {
      expect(() => assertSingleFileAvailable(target, true)).toThrow(
        expect.objectContaining({ code: "output.normalizationConflict" }),
      );
    }
    expect(() => assertSingleFileAvailable(path.join(tmp, `${planned.toUpperCase()}.png`), true)).toThrow(
      expect.objectContaining({ code: "output.caseConflict" }),
    );
  });

  it("checks every distinct equivalent entry before overwrite, including hard links", async () => {
    const existing = path.join(tmp, "cafe\u0301.png");
    const planned = path.join(tmp, "caf\u00e9.png");
    await writeFile(existing, "old image");
    if (statSync(planned, { throwIfNoEntry: false }) === undefined) {
      await link(existing, planned);
      for (const target of [existing, planned]) {
        expect(() => assertSingleFileAvailable(target, true)).toThrow(
          expect.objectContaining({ code: "output.normalizationConflict" }),
        );
      }
      expect(await readdir(tmp)).toHaveLength(2);
    } else {
      expect(() => assertSingleFileAvailable(planned, true)).not.toThrow();
      expect(await readdir(tmp)).toHaveLength(1);
    }
  });
});

describe("resolveOutputPath", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-lv-resolve-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("defaults outDir to the input file's directory", async () => {
    const input = path.join(tmp, "src", "foo.png");
    const out = await resolveOutputPath(
      {},
      { inputForDir: input, stem: "foo-trim", ext: "png" },
    );
    expect(out).toBe(path.join(tmp, "src", "foo-trim.png"));
  });

  it("honors an explicit outDir over the input dir", async () => {
    const input = path.join(tmp, "src", "foo.png");
    const outDir = path.join(tmp, "out");
    const out = await resolveOutputPath(
      { outDir },
      { inputForDir: input, stem: "foo-trim", ext: "png" },
    );
    expect(out).toBe(path.join(outDir, "foo-trim.png"));
  });

  it("treats an absolute outName (stem) as the full path (outDir is ignored)", async () => {
    const input = path.join(tmp, "src", "foo.png");
    const absStem = path.join(tmp, "elsewhere", "explicit");
    const out = await resolveOutputPath(
      { outDir: path.join(tmp, "ignored"), outName: absStem },
      { inputForDir: input, stem: "ignored-default", ext: "png" },
    );
    expect(out).toBe(`${absStem}.png`);
  });

  it("accepts an absolute output stem without an input or outDir", async () => {
    const stem = path.join(tmp, "chosen", "backplate");
    const out = await resolveOutputPath({ outName: stem }, { stem: "default", ext: "png" });
    expect(out).toBe(`${stem}.png`);
    await writeFile(out, "x");
  });

  it("throws when a verb supplies neither an input file nor a chosen destination", async () => {
    await expect(
      resolveOutputPath({}, { stem: "x", ext: "png" }),
    ).rejects.toMatchObject({ code: "args.invalid", details: { field: "outDir" } });
  });

  it("creates the resolved outDir (mkdir -p)", async () => {
    const deep = path.join(tmp, "a", "b", "c");
    const out = await resolveOutputPath(
      { outDir: deep },
      { stem: "x", ext: "png" },
    );
    expect(out).toBe(path.join(deep, "x.png"));
    // mkdir -p should make the dir writable now:
    await writeFile(out, "x");
  });

  it("appends the extension to a bare out-name stem (strict: out-name is a stem)", async () => {
    const input = path.join(tmp, "src", "foo.png");
    const out = await resolveOutputPath(
      { outName: "custom" },
      { inputForDir: input, stem: "ignored-default", ext: "png" },
    );
    expect(out).toBe(path.join(tmp, "src", "custom.png"));
  });

  it("double-extensions an out-name stem that already carries one (strict: surfaces misuse)", async () => {
    const input = path.join(tmp, "src", "foo.png");
    const out = await resolveOutputPath(
      { outName: "custom.png" },
      { inputForDir: input, stem: "ignored-default", ext: "png" },
    );
    expect(out).toBe(path.join(tmp, "src", "custom.png.png"));
  });
});

describe("withVerbLogger", () => {
  const ctx = (over: Partial<SdkContext> = {}): SdkContext => ({
    apiKey: null,
    modelsDir: "/models",
    debug: false,
    startup: { emitted: true },
    policy: {},
    ...over,
  });

  /** Run `body` through the wrapper and collect the events it emits. */
  async function run<T>(verb: VerbName, body: Parameters<typeof withVerbLogger<T>>[3], c = ctx()) {
    const events: SdkEvent[] = [];
    const outcome = withVerbLogger(c, verb, { onEvent: (e) => events.push(e) }, body);
    return { outcome, events };
  }

  it("returns the body's result and hands the body's events to onEvent", async () => {
    const { outcome, events } = await run("compose", async (logger) => {
      logger.emit("info", "resolve", { event: "verb.start", input: "/in.png", output: "/out.png", settings: { x: 1 } });
      return { ok: true as const };
    });
    expect(await outcome).toEqual({ ok: true });
    expect(events).toEqual([
      expect.objectContaining({ verb: "compose", level: "info", stage: "resolve", event: "verb.start", message: "verb started", input: "/in.png", settings: { x: 1 } }),
    ]);
  });

  it("reports the thrown error as verb.failed with its data and its diagnostic cause chain, and rethrows it", async () => {
    const err = new GptImgError("fs.failed", "outer failure", { cause: new TypeError("inner failure") });
    const { outcome, events } = await run("mask", async () => {
      throw err;
    });
    await expect(outcome).rejects.toBe(err);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: "error",
      stage: "error",
      event: "verb.failed",
      error: { code: "fs.failed", kind: "unavailable", effect: "none", message: "outer failure" },
      diagnostic: { type: "GptImgError", code: "fs.failed", message: "outer failure", stack: expect.any(String), cause: { type: "TypeError", message: "inner failure" } },
    });
  });

  it("keeps the provider's own failed response in the reported cause", async () => {
    const body = { message: "Invalid size", type: "invalid_request_error", param: "size", code: "invalid_value" };
    const cause = new APIError(400, body, undefined, new Headers({ "x-request-id": "req_123" }));
    const { outcome, events } = await run("generate", async () => {
      throw new GptImgError("provider.rejected", "OpenAI images.generate failed", { cause });
    });
    await expect(outcome).rejects.toMatchObject({ code: "provider.rejected" });
    const diagnostic = (events[0] as Extract<SdkEvent, { event: "verb.failed" }>).diagnostic;
    expect(diagnostic.cause?.response).toEqual({ status: 400, headers: { "x-request-id": "req_123" }, requestId: "req_123", body });
  });

  it("turns a refusal into a refused result, reported as verb.refused", async () => {
    const { outcome, events } = await run("mask", async () => {
      refuse("output.exists", "Output exists: x", { subject: "/x" });
    });
    expect(await outcome).toEqual({
      status: "refused",
      refusal: { code: "output.exists", message: "Output exists: x", subject: "/x", safeReason: null },
    });
    expect(events).toEqual([expect.objectContaining({ level: "warn", event: "verb.refused", code: "output.exists", subject: "/x" })]);
  });

  it("wraps a failure that escaped classification as internal.unexpected with its cause", async () => {
    const cause = new TypeError("surprise");
    await expect(
      withVerbLogger(ctx(), "mask", {}, async () => {
        throw cause;
      }),
    ).rejects.toMatchObject({ name: "GptImgError", code: "internal.unexpected", kind: "internal", cause });
  });

  it("refuses an unknown call option, with a hint for the retired log option", async () => {
    await expect(withVerbLogger(ctx(), "mask", { log: { file: "/x.log" } } as never, async () => 1)).rejects.toMatchObject({
      code: "args.invalid",
      details: { field: "log", constraint: "retired" },
    });
    await expect(withVerbLogger(ctx(), "mask", { onevent: () => {} } as never, async () => 1)).rejects.toMatchObject({
      details: { field: "onevent", constraint: "known call option" },
    });
  });

  it("refuses a signal that is not an AbortSignal and a hook that is not a function", async () => {
    await expect(withVerbLogger(ctx(), "encode", { signal: {} as AbortSignal }, async () => 1)).rejects.toMatchObject({
      code: "args.invalid",
      details: { field: "signal" },
    });
    await expect(withVerbLogger(ctx(), "encode", { onProgress: "log" as never }, async () => 1)).rejects.toMatchObject({
      code: "args.invalid",
      details: { field: "onProgress" },
    });
  });

  it("reports whatever interrupted work throws after the signal fired as the cancellation, recorded as one", async () => {
    const controller = new AbortController();
    const events: SdkEvent[] = [];
    const run = withVerbLogger(ctx(), "encode", { signal: controller.signal, onEvent: (e) => events.push(e) }, async () => {
      controller.abort();
      throw new Error("sharp: VipsJpeg: premature end of input");
    });
    await expect(run).rejects.toMatchObject({ code: "cancelled", kind: "cancelled", effect: "unknown" });
    expect(events.map((e) => [e.event, e.level])).toContainEqual(["verb.cancelled", "info"]);
    expect(events.some((e) => e.event === "verb.failed")).toBe(false);
  });

  it("accepts the same call options on every verb, onPartialImage included", async () => {
    const opts = { signal: new AbortController().signal, onEvent: () => {}, onProgress: () => {}, onPartialImage: () => {} };
    await expect(withVerbLogger(ctx(), "encode", opts, async () => 1)).resolves.toBe(1);
    await expect(withVerbLogger(ctx(), "model", opts, async () => 1)).resolves.toBe(1);
  });

  it("emits the startup event once, to the first call that listens", async () => {
    const shared = ctx({ startup: { emitted: false } });
    await withVerbLogger(shared, "trim", {}, async () => 1);
    const first = await run("trim", async () => 1, shared);
    await first.outcome;
    const second = await run("trim", async () => 1, shared);
    await second.outcome;
    expect(first.events.map((e) => e.event)).toEqual(["sdk.start"]);
    expect(second.events).toEqual([]);
  });
});

