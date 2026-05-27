import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GptImg } from "../../src/gptimg.js";
import { obfuscate } from "../../src/profile/obfuscate.js";
import type { Provider } from "../../src/providers/types.js";

const providerCalls = vi.hoisted(() => ({
  generate: vi.fn(),
  edit: vi.fn(),
  vision: vi.fn(),
}));

vi.mock("../../src/providers/index.js", () => ({
  getProvider: vi.fn(
    (): Provider => ({
      name: "openai",
      generate: providerCalls.generate,
      edit: providerCalls.edit,
      vision: providerCalls.vision,
    }),
  ),
}));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "..", "fixtures");

function fixture(name: string): string {
  return path.join(FIXTURES, name);
}

function lines(text: string): Array<Record<string, unknown>> {
  return text
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("AI verb implementations with mocked provider", () => {
  let tmp: string;
  let sdk: GptImg;
  let png: Uint8Array;

  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("OPENAI_API_KEY", undefined);
    providerCalls.generate.mockReset();
    providerCalls.edit.mockReset();
    providerCalls.vision.mockReset();

    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-ai-verbs-"));
    sdk = new GptImg({ profileDir: tmp, logDir: path.join(tmp, "logs") });
    png = new Uint8Array(await readFile(fixture("green-disk.png")));
    await writeFile(
      path.join(tmp, "profile.json"),
      JSON.stringify({
        provider: "openai",
        apiKey: obfuscate("sk-profile-only"),
      }) + "\n",
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tmp, { recursive: true, force: true });
  });

  it("generate uses the stored profile key, writes outputs, sidecar, and logs", async () => {
    const stdoutWrite = process.stdout.write;
    const stderrWrite = process.stderr.write;
    const stdout = vi.fn(() => true);
    const stderr = vi.fn(() => true);
    process.stdout.write = stdout as unknown as typeof process.stdout.write;
    process.stderr.write = stderr as unknown as typeof process.stderr.write;
    try {
      providerCalls.generate.mockResolvedValue({
        raw: {
          data: [
            { b64_json: Buffer.from(png).toString("base64") },
            { b64_json: "not-written" },
          ],
        },
        images: [{ data: png }, { data: null, error: "provider skipped it" }],
      });

      const outDir = path.join(tmp, "out");
      const result = await sdk.generate({
        prompt: "a green disk",
        outDir,
        outName: "gen",
        patch: '{"generate":{"quality":"low"},"chroma":{"color":"#00ff00"}}',
        set: ["n=2", "model=param-model"],
      });

      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
      expect(result.partial).toBe(true);
      expect(result.files).toHaveLength(1);
      expect(result.files[0]).toMatchObject({
        index: 1,
        path: path.join(outDir, "gen-1.png"),
        format: "png",
      });
      expect(existsSync(path.join(outDir, "gen-1.png"))).toBe(true);
      expect(result.sidecarPath).toBe(path.join(outDir, "gen.json"));

      const call = providerCalls.generate.mock.calls[0]?.[0];
      expect(call).toMatchObject({
        profile: {
          apiKey: "sk-profile-only",
          apiKeySource: "profile.apiKey",
        },
        params: { quality: "low", n: 2, model: "param-model" },
      });
      expect(call?.params).not.toHaveProperty("chromaKey");
      expect(call?.params).not.toHaveProperty("chroma");
      expect(call?.prompt).toContain("a green disk");
      expect(call?.prompt).toContain("solid #00ff00 chroma-key background");

      const sidecar = JSON.parse(await readFile(result.sidecarPath, "utf-8")) as {
        request: Record<string, unknown>;
        response: { data: Array<{ b64_json: string | null }> };
        files: Array<{ name: string }>;
      };
      expect(sidecar.request.chroma).toEqual({ color: "#00ff00" });
      expect(sidecar.response.data[0]?.b64_json).toBeNull();
      expect(sidecar.files).toEqual([expect.objectContaining({ name: "gen-1.png" })]);

      const logEntries = lines(await readFile(result.logPath, "utf-8"));
      expect(logEntries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ stage: "resolve" }),
          expect.objectContaining({ stage: "request" }),
          expect.objectContaining({ stage: "response" }),
          expect.objectContaining({ stage: "write" }),
        ]),
      );
    } finally {
      process.stdout.write = stdoutWrite;
      process.stderr.write = stderrWrite;
    }
  });

  it("generate layers recipe file, patch, and set with a custom profile path", async () => {
    const profilePath = path.join(tmp, "custom-profile.json");
    const recipePath = path.join(tmp, "recipe.json");
    await writeFile(
      profilePath,
      JSON.stringify({
        provider: "openai",
        apiKey: obfuscate("sk-custom-profile"),
      }) + "\n",
    );
    await writeFile(
      recipePath,
      JSON.stringify({
        generate: {
          size: "from-file",
          quality: "file-quality",
          n: 1,
        },
        edit: { size: "file-edit-size" },
      }) + "\n",
    );
    providerCalls.generate.mockResolvedValue({
      raw: { data: [{ b64_json: Buffer.from(png).toString("base64") }] },
      images: [{ data: png }],
    });

    const result = await sdk.generate({
      prompt: "layered",
      profile: profilePath,
      recipe: recipePath,
      outDir: path.join(tmp, "layered-out"),
      outName: "layered",
      patch: '{"generate":{"quality":"patch-quality","n":2}}',
      set: ["quality=set-quality", "n=3", "edit.size=set-edit-size"],
    });

    expect(path.basename(result.files[0]?.path ?? "")).toBe("layered-1.png");
    const call = providerCalls.generate.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      profile: {
        apiKey: "sk-custom-profile",
        apiKeySource: "profile.apiKey",
      },
      params: {
        size: "from-file",
        quality: "set-quality",
        n: 3,
      },
    });
    expect(call?.params).not.toHaveProperty("edit");
  });

  it("generate marks invalid image bytes as partial and preserves later indexes", async () => {
    providerCalls.generate.mockResolvedValue({
      raw: {
        data: [
          { b64_json: "invalid" },
          { b64_json: Buffer.from(png).toString("base64") },
        ],
      },
      images: [{ data: new Uint8Array([1, 2, 3]) }, { data: png }],
    });

    const result = await sdk.generate({
      prompt: "partial",
      outDir: path.join(tmp, "partial-out"),
      outName: "partial",
      set: ["n=2"],
    });

    expect(result.partial).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({
      index: 2,
      path: path.join(tmp, "partial-out", "partial-2.png"),
    });
  });

  it("SDK generate does not write to stdout or stderr when it fails", async () => {
    const stdoutWrite = process.stdout.write;
    const stderrWrite = process.stderr.write;
    const stdout = vi.fn(() => true);
    const stderr = vi.fn(() => true);
    process.stdout.write = stdout as unknown as typeof process.stdout.write;
    process.stderr.write = stderr as unknown as typeof process.stderr.write;
    providerCalls.generate.mockRejectedValue(new Error("provider boom"));
    try {
      await expect(
        sdk.generate({
          prompt: "will fail",
          outDir: path.join(tmp, "failed-out"),
          outName: "failed",
        }),
      ).rejects.toThrow("provider boom");
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      process.stdout.write = stdoutWrite;
      process.stderr.write = stderrWrite;
    }
  });

  it("edit supports input plus mask and writes basename-only sidecar fields", async () => {
    const input = path.join(tmp, "input.png");
    const mask = path.join(tmp, "mask.png");
    await copyFile(fixture("green-disk.png"), input);
    await copyFile(fixture("green-disk.png"), mask);
    providerCalls.edit.mockResolvedValue({
      raw: { data: [{ b64_json: Buffer.from(png).toString("base64") }] },
      images: [{ data: png }],
    });

    const result = await sdk.edit({
      prompt: "make it blue",
      in: input,
      mask,
      outDir: path.join(tmp, "edits"),
      outName: "edit",
    });

    expect(result.partial).toBe(false);
    expect(result.files[0]?.path).toBe(path.join(tmp, "edits", "edit.png"));
    const call = providerCalls.edit.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      prompt: "make it blue",
      imagePath: input,
      maskPath: mask,
    });

    const sidecar = JSON.parse(await readFile(result.sidecarPath, "utf-8")) as {
      request: { input: string; mask: string };
      response: { data: Array<{ b64_json: string | null }> };
    };
    expect(sidecar.request.input).toBe("input.png");
    expect(sidecar.request.mask).toBe("mask.png");
    expect(sidecar.response.data[0]?.b64_json).toBeNull();
    expect(lines(await readFile(result.logPath, "utf-8"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: "resolve" }),
        expect.objectContaining({ stage: "request" }),
        expect.objectContaining({ stage: "response" }),
        expect.objectContaining({ stage: "write" }),
      ]),
    );
  });

  it("edit supports mask-less calls", async () => {
    const input = path.join(tmp, "input.png");
    await copyFile(fixture("green-disk.png"), input);
    providerCalls.edit.mockResolvedValue({
      raw: { data: [{ b64_json: Buffer.from(png).toString("base64") }] },
      images: [{ data: png }],
    });

    await sdk.edit({
      prompt: "make it blue",
      in: input,
      outDir: path.join(tmp, "edits"),
      outName: "edit-without-mask",
    });

    const call = providerCalls.edit.mock.calls[0]?.[0];
    expect(call).toMatchObject({ imagePath: input });
    expect(call?.maskPath).toBeUndefined();
  });

  it("edit uses edit-scoped recipe values without leaking generate settings", async () => {
    const input = path.join(tmp, "recipe-edit-input.png");
    const recipe = path.join(tmp, "edit-recipe.json");
    await copyFile(fixture("green-disk.png"), input);
    await writeFile(
      recipe,
      JSON.stringify({
        generate: { quality: "generate-only" },
        edit: { size: "edit-from-file", n: 1 },
      }) + "\n",
    );
    providerCalls.edit.mockResolvedValue({
      raw: { data: [{ b64_json: Buffer.from(png).toString("base64") }] },
      images: [{ data: png }],
    });

    await sdk.edit({
      prompt: "recipe edit",
      in: input,
      recipe,
      outDir: path.join(tmp, "recipe-edit-out"),
      outName: "recipe-edit",
      patch: '{"edit":{"n":2}}',
      set: ["size=edit-from-set"],
    });

    const call = providerCalls.edit.mock.calls[0]?.[0];
    expect(call?.params).toMatchObject({
      size: "edit-from-set",
      n: 2,
    });
    expect(call?.params).not.toHaveProperty("quality");
  });

  it("generate rejects output collisions unless overwrite is enabled", async () => {
    providerCalls.generate.mockResolvedValue({
      raw: { data: [{ b64_json: Buffer.from(png).toString("base64") }] },
      images: [{ data: png }],
    });
    const outDir = path.join(tmp, "collision-out");
    await sdk.generate({ prompt: "first", outDir, outName: "same" });

    await expect(
      sdk.generate({ prompt: "second", outDir, outName: "same" }),
    ).rejects.toMatchObject({ code: "output.exists" });

    await expect(
      sdk.generate({ prompt: "third", outDir, outName: "same", overwrite: true }),
    ).resolves.toMatchObject({ partial: false });
  });

  it("generate rejects sidecar collisions before writing new images", async () => {
    providerCalls.generate.mockResolvedValue({
      raw: { data: [{ b64_json: Buffer.from(png).toString("base64") }] },
      images: [{ data: png }],
    });
    const outDir = path.join(tmp, "sidecar-collision-out");
    await sdk.generate({ prompt: "first", outDir, outName: "same" });

    providerCalls.generate.mockResolvedValue({
      raw: {
        data: [
          { b64_json: Buffer.from(png).toString("base64") },
          { b64_json: Buffer.from(png).toString("base64") },
        ],
      },
      images: [{ data: png }, { data: png }],
    });

    await expect(
      sdk.generate({
        prompt: "second",
        outDir,
        outName: "same",
        set: ["n=2"],
      }),
    ).rejects.toMatchObject({ code: "output.exists" });
    expect(existsSync(path.join(outDir, "same-1.png"))).toBe(false);
    expect(existsSync(path.join(outDir, "same-2.png"))).toBe(false);
  });

  it("generate uses the default output directory and n>1 file names", async () => {
    providerCalls.generate.mockResolvedValue({
      raw: {
        data: [
          { b64_json: Buffer.from(png).toString("base64") },
          { b64_json: Buffer.from(png).toString("base64") },
        ],
      },
      images: [{ data: png }, { data: png }],
    });

    const result = await sdk.generate({
      prompt: "two images",
      outName: "two",
      set: ["n=2"],
    });

    expect(result.files.map((f) => path.relative(tmp, f.path))).toEqual([
      path.join("output", "two-1.png"),
      path.join("output", "two-2.png"),
    ]);
    expect(result.sidecarPath).toBe(path.join(tmp, "output", "two.json"));
  });

  it("edit writes n>1 output names", async () => {
    const input = path.join(tmp, "input.png");
    await copyFile(fixture("green-disk.png"), input);
    providerCalls.edit.mockResolvedValue({
      raw: {
        data: [
          { b64_json: Buffer.from(png).toString("base64") },
          { b64_json: Buffer.from(png).toString("base64") },
        ],
      },
      images: [{ data: png }, { data: png }],
    });

    const result = await sdk.edit({
      prompt: "make two",
      in: input,
      outDir: path.join(tmp, "edit-two"),
      outName: "edited",
      set: ["n=2"],
    });

    expect(result.files.map((f) => path.basename(f.path))).toEqual([
      "edited-1.png",
      "edited-2.png",
    ]);
  });

  it("edit rejects sidecar collisions before writing new images", async () => {
    const input = path.join(tmp, "sidecar-edit-input.png");
    const outDir = path.join(tmp, "edit-sidecar-collision");
    await copyFile(fixture("green-disk.png"), input);
    providerCalls.edit.mockResolvedValue({
      raw: { data: [{ b64_json: Buffer.from(png).toString("base64") }] },
      images: [{ data: png }],
    });
    await sdk.edit({ prompt: "first", in: input, outDir, outName: "same" });

    providerCalls.edit.mockResolvedValue({
      raw: {
        data: [
          { b64_json: Buffer.from(png).toString("base64") },
          { b64_json: Buffer.from(png).toString("base64") },
        ],
      },
      images: [{ data: png }, { data: png }],
    });

    await expect(
      sdk.edit({
        prompt: "second",
        in: input,
        outDir,
        outName: "same",
        set: ["n=2"],
      }),
    ).rejects.toMatchObject({ code: "output.exists" });
    expect(existsSync(path.join(outDir, "same-1.png"))).toBe(false);
    expect(existsSync(path.join(outDir, "same-2.png"))).toBe(false);
  });

  it("edit marks invalid image bytes as partial and still writes valid later items", async () => {
    const input = path.join(tmp, "input.png");
    await copyFile(fixture("green-disk.png"), input);
    providerCalls.edit.mockResolvedValue({
      raw: {
        data: [
          { b64_json: "invalid" },
          { b64_json: Buffer.from(png).toString("base64") },
        ],
      },
      images: [{ data: new Uint8Array([9, 8, 7]) }, { data: png }],
    });

    const result = await sdk.edit({
      prompt: "partial edit",
      in: input,
      outDir: path.join(tmp, "edit-partial"),
      outName: "edited",
      set: ["n=2"],
    });

    expect(result.partial).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({
      index: 2,
      path: path.join(tmp, "edit-partial", "edited-2.png"),
    });
  });

  it("vision prepares multiple images, applies shrink settings, and writes a sidecar", async () => {
    const first = path.join(tmp, "first.png");
    const second = path.join(tmp, "second.png");
    await copyFile(fixture("green-disk.png"), first);
    await copyFile(fixture("green-disk.png"), second);
    providerCalls.vision.mockResolvedValue({
      raw: { id: "vision-response" },
      verdict: { ok: true, score: 0.9, reasons: ["looks correct"] },
    });

    const result = await sdk.vision({
      in: [first, second],
      check: "both are green disks",
      outDir: path.join(tmp, "vision-out"),
      outName: "vision",
      set: ['shrink={"width":64,"height":64}', "model=vision-model", "detail=high"],
    });

    expect(result).toMatchObject({
      ok: true,
      score: 0.9,
      reasons: ["looks correct"],
    });
    const call = providerCalls.vision.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      check: "both are green disks",
      params: { model: "vision-model" },
    });
    expect(call?.images).toHaveLength(2);
    expect(call?.images[0]?.format).toBe("png");
    expect(call?.images[0]?.detail).toBe("high");

    const sidecar = JSON.parse(await readFile(result.sidecarPath, "utf-8")) as {
      request: {
        detail?: string;
        inputs: Array<{ name: string; shrink: { applied: boolean; outputWidth: number } }>;
      };
      response: { verdict: { ok: boolean } };
    };
    expect(sidecar.request.detail).toBe("high");
    expect(sidecar.request.inputs.map((x) => x.name)).toEqual([
      "first.png",
      "second.png",
    ]);
    expect(sidecar.request.inputs[0]?.shrink).toMatchObject({
      applied: true,
      outputWidth: 64,
    });
    expect(sidecar.response.verdict.ok).toBe(true);
  });

  it("vision supports a single image input", async () => {
    const input = path.join(tmp, "single.png");
    await copyFile(fixture("green-disk.png"), input);
    providerCalls.vision.mockResolvedValue({
      raw: {},
      verdict: { ok: false, score: 0.2, reasons: ["not enough"] },
    });

    const result = await sdk.vision({
      in: input,
      check: "is this transparent?",
      outDir: path.join(tmp, "vision-single"),
      outName: "single",
    });

    expect(result.ok).toBe(false);
    expect(providerCalls.vision.mock.calls[0]?.[0].images).toHaveLength(1);
    const sidecar = JSON.parse(await readFile(result.sidecarPath, "utf-8")) as {
      request: { inputs: Array<{ shrink: { applied: boolean; outputWidth: number } }> };
    };
    expect(sidecar.request.inputs[0]?.shrink).toMatchObject({
      applied: false,
      outputWidth: 128,
    });
  });

  it("vision applies custom shrink settings from a recipe file", async () => {
    const input = path.join(tmp, "recipe-vision.png");
    const recipe = path.join(tmp, "vision-recipe.json");
    await copyFile(fixture("green-disk.png"), input);
    await writeFile(
      recipe,
      JSON.stringify({ vision: { shrink: { width: 32, height: 32 } } }) + "\n",
    );
    providerCalls.vision.mockResolvedValue({
      raw: {},
      verdict: { ok: true, score: 1, reasons: [] },
    });

    const result = await sdk.vision({
      in: input,
      check: "small enough",
      recipe,
      outDir: path.join(tmp, "recipe-vision-out"),
      outName: "recipe-vision",
    });

    const sidecar = JSON.parse(await readFile(result.sidecarPath, "utf-8")) as {
      request: { inputs: Array<{ shrink: { applied: boolean; outputWidth: number } }> };
    };
    expect(sidecar.request.inputs[0]?.shrink).toMatchObject({
      applied: true,
      outputWidth: 32,
    });
  });

  it("chroma verify runs only when the removed fraction exceeds the threshold", async () => {
    const input = path.join(tmp, "chroma-input.png");
    await copyFile(fixture("green-disk.png"), input);
    providerCalls.vision.mockResolvedValue({
      raw: {},
      verdict: { ok: true, score: 1, reasons: ["verified"] },
    });

    const verified = await sdk.chroma({
      in: input,
      outDir: path.join(tmp, "chroma-verify"),
      outName: "verified.png",
      maskName: false,
      verify: "background removed",
      verifyThreshold: 0.1,
    });

    expect(verified.verify).toMatchObject({ ok: true, score: 1 });
    expect(verified.alphaVerify?.metrics.borderTransparentArea).toBeGreaterThan(0);
    expect(verified.verify?.logPath).toBe(verified.logPath);
    expect(verified.verify?.sidecarPath).toBe(
      path.join(tmp, "chroma-verify", "verified-verify.json"),
    );
    expect(verified.verify?.previewPath).toBe(
      path.join(tmp, "chroma-verify", "verified-verify-preview.png"),
    );
    expect(providerCalls.vision.mock.calls[0]?.[0].images[0]).toEqual(
      expect.objectContaining({ format: "png" }),
    );
    const sharedLog = lines(await readFile(verified.logPath, "utf-8"));
    expect(sharedLog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ verb: "chroma", stage: "request" }),
        expect.objectContaining({
          verb: "chroma",
          stage: "stats",
          msg: "local alpha verification complete",
        }),
        expect.objectContaining({ verb: "vision", stage: "request" }),
        expect.objectContaining({ verb: "vision", stage: "response" }),
      ]),
    );
    expect(providerCalls.vision).toHaveBeenCalledTimes(1);

    const skipped = await sdk.chroma({
      in: input,
      outDir: path.join(tmp, "chroma-verify"),
      outName: "skipped.png",
      maskName: false,
      verify: "background removed",
      verifyThreshold: 1,
    });

    expect(skipped.verify).toBeUndefined();
    expect(providerCalls.vision).toHaveBeenCalledTimes(1);
  });
});
