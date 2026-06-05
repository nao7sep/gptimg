import { PassThrough } from "node:stream";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { LocalOpError } from "../../src/errors.js";
import { runCli } from "../../src/cli/run.js";

const sdkCalls = vi.hoisted(() => ({
  generate: vi.fn(),
  edit: vi.fn(),
  vision: vi.fn(),
  mask: vi.fn(),
  compose: vi.fn(),
  combine: vi.fn(),
  setApiKey: vi.fn(),
  clearApiKey: vi.fn(),
}));

vi.mock("../../src/gptimg.js", () => ({
  GptImg: class {
    readonly profile = {
      setApiKey: sdkCalls.setApiKey,
      clearApiKey: sdkCalls.clearApiKey,
    };

    generate = sdkCalls.generate;
    edit = sdkCalls.edit;
    vision = sdkCalls.vision;
    mask = sdkCalls.mask;
    compose = sdkCalls.compose;
    combine = sdkCalls.combine;
  },
}));

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function captureChunk(chunk: unknown): string {
  if (Buffer.isBuffer(chunk)) return chunk.toString("utf-8");
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf-8");
  return String(chunk);
}

async function run(args: string[]): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;

  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    stdout += captureChunk(chunk);
    const callback = rest.find((x) => typeof x === "function") as
      | (() => void)
      | undefined;
    callback?.();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    stderr += captureChunk(chunk);
    const callback = rest.find((x) => typeof x === "function") as
      | (() => void)
      | undefined;
    callback?.();
    return true;
  }) as typeof process.stderr.write;

  try {
    const code = await runCli(["node", "gptimg", ...args]);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
}

async function runWithStdin(args: string[], stdinText: string): Promise<CliResult> {
  const input = new PassThrough();
  input.end(stdinText);
  const original = Object.getOwnPropertyDescriptor(process, "stdin");
  Object.defineProperty(process, "stdin", {
    configurable: true,
    value: input,
  });
  try {
    return await run(args);
  } finally {
    if (original) {
      Object.defineProperty(process, "stdin", original);
    }
  }
}

describe("CLI success contracts", () => {
  beforeEach(() => {
    for (const fn of Object.values(sdkCalls)) fn.mockReset();
    sdkCalls.generate.mockResolvedValue({ files: [], logPath: "l.jsonl", partial: false });
    sdkCalls.edit.mockResolvedValue({ files: [], logPath: "l.jsonl", partial: false });
    sdkCalls.vision.mockResolvedValue({ ok: true, score: 1, reasons: ["ok"], raw: {}, sidecarPath: "v.json", logPath: "l.jsonl" });
    sdkCalls.mask.mockResolvedValue({
      input: "in.png",
      output: "in-mask.png",
      stats: { key: "#00ff00", keySource: "explicit", preserveInterior: false, removedPixels: 0, removedFraction: 0, width: 1, height: 1 },
      logPath: "l.jsonl",
    });
    sdkCalls.compose.mockResolvedValue({
      input: "in.png",
      mask: "in-mask.png",
      output: "in-composed.png",
      width: 1,
      height: 1,
      over: "transparent",
      logPath: "l.jsonl",
    });
    sdkCalls.combine.mockResolvedValue({
      inputs: ["a.png", "b.png"],
      output: "a-union.png",
      width: 1,
      height: 1,
      op: "union",
      logPath: "l.jsonl",
    });
    sdkCalls.setApiKey.mockResolvedValue(undefined);
    sdkCalls.clearApiKey.mockResolvedValue(undefined);
  });

  it("generate forwards options and emits JSON on stdout", async () => {
    const result = await run([
      "generate",
      "prompt",
      "--profile",
      "profile.json",
      "--recipe",
      "recipe.json",
      "--log",
      "log.jsonl",
      "--out-dir",
      "out",
      "--out-name",
      "name",
      "--set",
      "n=1",
      "quality=low",
      "--overwrite",
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      files: [],
      logPath: "l.jsonl",
      partial: false,
    });
    expect(sdkCalls.generate).toHaveBeenCalledWith(
      {
        prompt: "prompt",
        profile: "profile.json",
        recipe: "recipe.json",
        log: "log.jsonl",
        outDir: "out",
        outName: "name",
        set: ["n=1", "quality=low"],
        overwrite: true,
      },
      { signal: expect.any(AbortSignal), onProgress: expect.any(Function) },
    );
  });

  it("edit forwards input, mask, and common AI options", async () => {
    const result = await run([
      "edit",
      "prompt",
      "--in",
      "input.png",
      "--mask",
      "mask.png",
      "--out-name",
      "edited",
    ]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).partial).toBe(false);
    expect(sdkCalls.edit).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "prompt",
        in: "input.png",
        mask: "mask.png",
        outName: "edited",
      }),
      { signal: expect.any(AbortSignal), onProgress: expect.any(Function) },
    );
  });

  it("vision collects repeatable --in values", async () => {
    const result = await run([
      "vision",
      "--in",
      "a.png",
      "--in",
      "b.png",
      "--check",
      "both ok",
    ]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).ok).toBe(true);
    expect(sdkCalls.vision).toHaveBeenCalledWith(
      expect.objectContaining({
        in: ["a.png", "b.png"],
        check: "both ok",
      }),
      { signal: expect.any(AbortSignal), onProgress: expect.any(Function) },
    );
  });

  it("vision forwards a single --in value as a string", async () => {
    const result = await run([
      "vision",
      "--in",
      "one.png",
      "--check",
      "one ok",
    ]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).ok).toBe(true);
    expect(sdkCalls.vision).toHaveBeenCalledWith(
      expect.objectContaining({
        in: "one.png",
        check: "one ok",
      }),
      { signal: expect.any(AbortSignal), onProgress: expect.any(Function) },
    );
  });

  it("mask maps key, preserve-interior, and dry-run flags", async () => {
    const result = await run([
      "mask",
      "--in",
      "in.png",
      "--key",
      "#00ff00",
      "--preserve-interior",
      "--dry-run",
    ]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).output).toBe("in-mask.png");
    expect(sdkCalls.mask).toHaveBeenCalledWith(
      expect.objectContaining({
        in: "in.png",
        // CLI passes undefined for an omitted --method; the SDK applies the
        // "chroma" default (the CLI no longer owns a commander default).
        method: undefined,
        key: "#00ff00",
        preserveInterior: true,
        dryRun: true,
      }),
      { signal: expect.any(AbortSignal), onProgress: expect.any(Function) },
    );
  });

  it("compose forwards --over and --remove-bleed", async () => {
    const result = await run([
      "compose",
      "--in",
      "in.png",
      "--mask",
      "in-mask.png",
      "--over",
      "#ffffff",
      "--remove-bleed",
      "#00ff00",
    ]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).output).toBe("in-composed.png");
    expect(sdkCalls.compose).toHaveBeenCalledWith(
      expect.objectContaining({
        in: "in.png",
        mask: "in-mask.png",
        over: "#ffffff",
        removeBleed: "#00ff00",
      }),
      { signal: expect.any(AbortSignal), onProgress: expect.any(Function) },
    );
  });

  it("combine forwards op and repeated --in inputs", async () => {
    const result = await run([
      "combine",
      "union",
      "--in",
      "a.png",
      "--in",
      "b.png",
    ]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).output).toBe("a-union.png");
    expect(sdkCalls.combine).toHaveBeenCalledWith(
      expect.objectContaining({
        op: "union",
        inputs: ["a.png", "b.png"],
      }),
      { signal: expect.any(AbortSignal), onProgress: expect.any(Function) },
    );
  });

  it("profile set-key and clear-key emit ok JSON", async () => {
    const set = await run(["profile", "set-key", "--key", "sk-local", "--path", "p.json"]);
    expect(set.code).toBe(0);
    expect(JSON.parse(set.stdout)).toEqual({ ok: true });
    expect(sdkCalls.setApiKey).toHaveBeenCalledWith("sk-local", { path: "p.json" });

    const clear = await run(["profile", "clear-key", "--path", "p.json"]);
    expect(clear.code).toBe(0);
    expect(JSON.parse(clear.stdout)).toEqual({ ok: true });
    expect(sdkCalls.clearApiKey).toHaveBeenCalledWith({ path: "p.json" });
  });

  it("profile set-key reads from stdin", async () => {
    const result = await runWithStdin(
      ["profile", "set-key", "--stdin", "--path", "stdin-profile.json"],
      "sk-from-stdin\n",
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true });
    expect(sdkCalls.setApiKey).toHaveBeenCalledWith("sk-from-stdin", {
      path: "stdin-profile.json",
    });
  });

  it("emits runtime errors as a single JSON object on stderr", async () => {
    const cases: Array<{
      name: string;
      args: string[];
      fn: ReturnType<typeof vi.fn>;
    }> = [
      { name: "generate", args: ["generate", "prompt"], fn: sdkCalls.generate },
      {
        name: "edit",
        args: ["edit", "prompt", "--in", "input.png"],
        fn: sdkCalls.edit,
      },
      {
        name: "vision",
        args: ["vision", "--in", "in.png", "--check", "ok"],
        fn: sdkCalls.vision,
      },
      { name: "mask", args: ["mask", "--in", "in.png"], fn: sdkCalls.mask },
      {
        name: "compose",
        args: ["compose", "--in", "in.png", "--mask", "m.png"],
        fn: sdkCalls.compose,
      },
      {
        name: "combine",
        args: ["combine", "invert", "--in", "a.png"],
        fn: sdkCalls.combine,
      },
    ];

    for (const item of cases) {
      for (const fn of Object.values(sdkCalls)) fn.mockClear();
      item.fn.mockRejectedValueOnce(
        new LocalOpError("local.test", `${item.name} failed`),
      );
      const result = await run(item.args);
      expect(result.code, item.name).toBe(5);
      expect(result.stdout, item.name).toBe("");
      expect(result.stderr.trim().split("\n"), item.name).toHaveLength(1);
      expect(JSON.parse(result.stderr)).toEqual({
        error: {
          type: "localOp",
          code: "local.test",
          message: `${item.name} failed`,
        },
      });
    }
  });

  it("reports usage errors for invalid local option parsers", async () => {
    const cases = [
      [
        "bad mask key",
        ["mask", "--in", "in.png", "--key", "green"],
        "must be 'auto', 'from-sidecar', or '#rrggbb'",
      ],
      [
        "bad mask border-sample",
        ["mask", "--in", "in.png", "--border-sample", "large"],
        "--border-sample: must be a number",
      ],
      [
        "bad mask method choice",
        ["mask", "--in", "in.png", "--method", "nope"],
        "Allowed choices are chroma, ai",
      ],
      [
        "bad compose remove-bleed",
        ["compose", "--in", "in.png", "--mask", "m.png", "--remove-bleed", "green"],
        "--remove-bleed: must be #rrggbb",
      ],
      [
        "bad combine op",
        ["combine", "unknown-op", "--in", "a.png"],
        "Allowed choices are union, intersect, subtract, invert, feather",
      ],
      [
        "bad layer gravity choice",
        ["layer", "--base", "a.png", "--top", "b.png", "--gravity", "nope"],
        "Allowed choices are center, north",
      ],
      [
        "bad backplate shape choice",
        ["backplate", "--from", "#000000", "--to", "#ffffff", "--shape", "nope"],
        "Allowed choices are rect, squircle",
      ],
      [
        "bad resize kernel choice",
        ["resize", "--in", "a.png", "--to-size", "100", "--kernel", "nope"],
        "Allowed choices are nearest, cubic, mitchell, lanczos2, lanczos3",
      ],
      [
        "bad upscale kernel choice",
        ["upscale", "--in", "a.png", "--kernel", "nope"],
        "Allowed choices are nearest, cubic, mitchell, lanczos2, lanczos3",
      ],
      [
        "bad shadow offset format",
        ["shadow", "--in", "a.png", "--offset", "1"],
        'must be "x,y"',
      ],
      [
        "bad shadow blur format",
        ["shadow", "--in", "a.png", "--blur", "abc"],
        "--blur: must be a number",
      ],
    ] as const;

    for (const [name, args, message] of cases) {
      const result = await run([...args]);
      expect(result.code, name).toBe(2);
      expect(result.stderr, name).toContain(message);
    }
    expect(sdkCalls.mask).not.toHaveBeenCalled();
    expect(sdkCalls.compose).not.toHaveBeenCalled();
    expect(sdkCalls.combine).not.toHaveBeenCalled();
  });
});
