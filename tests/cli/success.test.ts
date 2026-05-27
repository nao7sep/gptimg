import { PassThrough } from "node:stream";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { LocalOpError } from "../../src/errors.js";
import { runCli } from "../../src/cli/run.js";

const sdkCalls = vi.hoisted(() => ({
  generate: vi.fn(),
  edit: vi.fn(),
  vision: vi.fn(),
  chroma: vi.fn(),
  inspect: vi.fn(),
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
    chroma = sdkCalls.chroma;
    inspect = sdkCalls.inspect;
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
    sdkCalls.generate.mockResolvedValue({ files: [], sidecarPath: "s.json", logPath: "l.jsonl", partial: false });
    sdkCalls.edit.mockResolvedValue({ files: [], sidecarPath: "e.json", logPath: "l.jsonl", partial: false });
    sdkCalls.vision.mockResolvedValue({ ok: true, score: 1, reasons: ["ok"], raw: {}, sidecarPath: "v.json", logPath: "l.jsonl" });
    sdkCalls.chroma.mockResolvedValue({ input: "in.png", outputs: { image: "out.png", mask: null }, stats: {}, logPath: "l.jsonl" });
    sdkCalls.inspect.mockResolvedValue({ input: "in.png", stats: { removedFraction: 0 }, logPath: "l.jsonl" });
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
      "--patch",
      "{}",
      "--overwrite",
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      files: [],
      sidecarPath: "s.json",
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
        patch: "{}",
        overwrite: true,
      },
      { signal: expect.any(AbortSignal) },
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
    expect(JSON.parse(result.stdout).sidecarPath).toBe("e.json");
    expect(sdkCalls.edit).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "prompt",
        in: "input.png",
        mask: "mask.png",
        outName: "edited",
      }),
      { signal: expect.any(AbortSignal) },
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
      { signal: expect.any(AbortSignal) },
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
      { signal: expect.any(AbortSignal) },
    );
  });

  it("chroma maps local options and boolean toggles", async () => {
    const result = await run([
      "chroma",
      "--in",
      "in.png",
      "--key",
      "#00ff00",
      "--mode",
      "all",
      "--no-despill",
      "--no-fill-holes",
      "--no-mask",
      "--verify",
      "transparent background",
      "--verify-threshold",
      "0.2",
    ]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).outputs.mask).toBeNull();
    expect(sdkCalls.chroma).toHaveBeenCalledWith(
      expect.objectContaining({
        in: "in.png",
        key: "#00ff00",
        mode: "all",
        despill: false,
        fillHoles: false,
        maskName: false,
        verify: "transparent background",
        verifyThreshold: 0.2,
      }),
      { signal: expect.any(AbortSignal) },
    );
  });

  it("inspect emits stats and maps explicit key options", async () => {
    const result = await run([
      "inspect",
      "--in",
      "in.png",
      "--key",
      "#00ff00",
      "--border-sample",
      "8",
      "--strict-confidence",
      "0.5",
    ]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      input: "in.png",
      stats: { removedFraction: 0 },
      logPath: "l.jsonl",
    });
    expect(sdkCalls.inspect).toHaveBeenCalledWith(
      expect.objectContaining({
        in: "in.png",
        key: "#00ff00",
        borderSample: 8,
        strictConfidence: 0.5,
      }),
      { signal: expect.any(AbortSignal) },
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
      { name: "chroma", args: ["chroma", "--in", "in.png"], fn: sdkCalls.chroma },
      { name: "inspect", args: ["inspect", "--in", "in.png"], fn: sdkCalls.inspect },
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
        "bad chroma key",
        ["chroma", "--in", "in.png", "--key", "green"],
        "must be 'auto', 'from-sidecar', or '#rrggbb'",
      ],
      [
        "bad chroma float",
        ["chroma", "--in", "in.png", "--inner-threshold", "wide"],
        "--inner-threshold: not a number",
      ],
      [
        "bad inspect int",
        ["inspect", "--in", "in.png", "--border-sample", "large"],
        "--border-sample: not a number",
      ],
      [
        "bad inspect choice",
        ["inspect", "--in", "in.png", "--metric", "rgb"],
        "Allowed choices are lab_de76",
      ],
    ] as const;

    for (const [name, args, message] of cases) {
      const result = await run([...args]);
      expect(result.code, name).toBe(2);
      expect(result.stderr, name).toContain(message);
    }
    expect(sdkCalls.chroma).not.toHaveBeenCalled();
    expect(sdkCalls.inspect).not.toHaveBeenCalled();
  });
});
