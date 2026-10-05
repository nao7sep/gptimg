import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
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
    const defaultProfile = path.join(tmp, "profile.json");
    await writeFile(
      defaultProfile,
      JSON.stringify({
        provider: "openai",
        apiKey: obfuscate("sk-profile-only"),
      }) + "\n",
    );
    if (process.platform !== "win32") await chmod(defaultProfile, 0o600);
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
        overrides: {
          generate: { quality: "low", n: 2, model: "param-model" },
          chroma: { color: "#00ff00" },
        },
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
      // Per-image sidecar contract: each image gets its own JSON. n=2 with the
      // first image dropped (partial) means only gen-2.json exists; but the
      // mocked response in this test path produces image index=1 only, so the
      // single survivor sits at gen-1.json.
      expect(result.files[0]?.sidecarPath).toBe(path.join(outDir, "gen-1.json"));

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
      expect(call?.prompt).toBe("a green disk");

      const sidecar = JSON.parse(
        await readFile(result.files[0]!.sidecarPath, "utf-8"),
      ) as {
        request: Record<string, unknown>;
        response: { data: Array<{ b64_json: string | null }> };
        files: Array<{ name: string }>;
      };
      expect(sidecar.request.chroma).toEqual({ color: "#00ff00" });
      expect(sidecar.response.data[0]?.b64_json).toBeNull();
      // Per-image sidecar: files[] holds just this image's entry.
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

  it("generate layers recipe file and overrides with a custom profile path", async () => {
    const profilePath = path.join(tmp, "custom-profile.json");
    const recipePath = path.join(tmp, "recipe.json");
    await writeFile(
      profilePath,
      JSON.stringify({
        provider: "openai",
        apiKey: obfuscate("sk-custom-profile"),
      }) + "\n",
    );
    if (process.platform !== "win32") await chmod(profilePath, 0o600);
    await writeFile(
      recipePath,
      JSON.stringify({
        generate: {
          size: "1024x1024",
          quality: "low",
          n: 1,
        },
        edit: { size: "1536x1024" },
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
      overrides: { generate: { quality: "high", n: 3 }, edit: { size: "1024x1536" } },
    });

    expect(path.basename(result.files[0]?.path ?? "")).toBe("layered-1.png");
    const call = providerCalls.generate.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      profile: {
        apiKey: "sk-custom-profile",
        apiKeySource: "profile.apiKey",
      },
      params: {
        size: "1024x1024",
        quality: "high",
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
      overrides: { generate: { n: 2 } },
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

    const sidecar = JSON.parse(
      await readFile(result.files[0]!.sidecarPath, "utf-8"),
    ) as {
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
        generate: { quality: "medium" },
        edit: { size: "1024x1024", n: 1 },
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
      overrides: { edit: { size: "1536x1024", n: 2 } },
    });

    const call = providerCalls.edit.mock.calls[0]?.[0];
    expect(call?.params).toMatchObject({
      size: "1536x1024",
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

  it("rejects a known-busy lexical stem alias before a second provider charge", async () => {
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let providerEntered!: () => void;
    const firstAtProvider = new Promise<void>((resolve) => {
      providerEntered = resolve;
    });
    providerCalls.generate.mockImplementation(async () => {
      providerEntered();
      await firstHeld;
      return {
        raw: { data: [{ b64_json: Buffer.from(png).toString("base64") }] },
        images: [{ data: png }],
      };
    });
    const outDir = path.join(tmp, "concurrent-out");
    const first = sdk.generate({ prompt: "first contender", outDir, outName: "same" });
    await firstAtProvider;

    await expect(
      sdk.generate({ prompt: "second contender", outDir, outName: "nested/../same" }),
    ).rejects.toMatchObject({ code: "output.busy" });
    expect(providerCalls.generate).toHaveBeenCalledOnce();

    releaseFirst();
    await expect(first).resolves.toMatchObject({ partial: false });
    const sidecar = JSON.parse(await readFile(path.join(outDir, "same.json"), "utf-8"));
    expect(sidecar.request.prompt).toBe("first contender");
    expect((await readdir(outDir)).some((name) => name.endsWith(".lock"))).toBe(false);
  });

  it("rejects an orphan image before a provider charge", async () => {
    const outDir = path.join(tmp, "orphan-image-out");
    await mkdir(outDir);
    await writeFile(path.join(outDir, "same.png"), png);
    providerCalls.generate.mockResolvedValue({
      raw: { data: [{ b64_json: Buffer.from(png).toString("base64") }] },
      images: [{ data: png }],
    });

    await expect(
      sdk.generate({ prompt: "must not be charged", outDir, outName: "same" }),
    ).rejects.toMatchObject({ code: "output.exists" });
    expect(providerCalls.generate).not.toHaveBeenCalled();
  });

  it("rejects a same-stem directory alias before a second provider charge", async () => {
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let providerEntered!: () => void;
    const firstAtProvider = new Promise<void>((resolve) => {
      providerEntered = resolve;
    });
    providerCalls.generate.mockImplementation(async () => {
      providerEntered();
      await firstHeld;
      return {
        raw: { data: [{ b64_json: Buffer.from(png).toString("base64") }] },
        images: [{ data: png }],
      };
    });
    const outDir = path.join(tmp, "alias-concurrent-out");
    const aliasDir = path.join(tmp, "alias-concurrent-link");
    await mkdir(outDir);
    await symlink(outDir, aliasDir, process.platform === "win32" ? "junction" : "dir");
    const first = sdk.generate({ prompt: "real path", outDir, outName: "same" });
    await firstAtProvider;

    await expect(
      sdk.generate({ prompt: "alias path", outDir: aliasDir, outName: "same", overwrite: true }),
    ).rejects.toMatchObject({ code: "output.busy" });
    expect(providerCalls.generate).toHaveBeenCalledOnce();

    releaseFirst();
    await expect(first).resolves.toMatchObject({ partial: false });
    const sidecar = JSON.parse(await readFile(path.join(outDir, "same.json"), "utf-8"));
    expect(sidecar.request.prompt).toBe("real path");
  });

  it("generate refuses --overwrite when stale indexed siblings from a prior n exist", async () => {
    providerCalls.generate.mockResolvedValue({
      raw: {
        data: [
          { b64_json: Buffer.from(png).toString("base64") },
          { b64_json: Buffer.from(png).toString("base64") },
          { b64_json: Buffer.from(png).toString("base64") },
        ],
      },
      images: [{ data: png }, { data: png }, { data: png }],
    });
    const outDir = path.join(tmp, "stale-out");

    await sdk.generate({
      prompt: "wider run",
      outDir,
      outName: "same",
      overrides: { generate: { n: 3 } },
    });
    expect(existsSync(path.join(outDir, "same-1.png"))).toBe(true);
    expect(existsSync(path.join(outDir, "same-2.png"))).toBe(true);
    expect(existsSync(path.join(outDir, "same-3.png"))).toBe(true);

    providerCalls.generate.mockResolvedValue({
      raw: { data: [{ b64_json: Buffer.from(png).toString("base64") }] },
      images: [{ data: png }],
    });

    await expect(
      sdk.generate({
        prompt: "narrower run",
        outDir,
        outName: "same",
        overwrite: true,
      }),
    ).rejects.toMatchObject({
      code: "output.staleSiblings",
      errorType: "localOp",
    });

    expect(existsSync(path.join(outDir, "same-1.png"))).toBe(true);
    expect(existsSync(path.join(outDir, "same-2.png"))).toBe(true);
    expect(existsSync(path.join(outDir, "same-3.png"))).toBe(true);
  });

  it("generate --overwrite succeeds when the prior group exactly matches the new plan", async () => {
    providerCalls.generate.mockResolvedValue({
      raw: {
        data: [
          { b64_json: Buffer.from(png).toString("base64") },
          { b64_json: Buffer.from(png).toString("base64") },
        ],
      },
      images: [{ data: png }, { data: png }],
    });
    const outDir = path.join(tmp, "matching-overwrite");

    await sdk.generate({
      prompt: "first",
      outDir,
      outName: "same",
      overrides: { generate: { n: 2 } },
    });

    await expect(
      sdk.generate({
        prompt: "second",
        outDir,
        outName: "same",
        overrides: { generate: { n: 2 } },
        overwrite: true,
      }),
    ).resolves.toMatchObject({ partial: false });
  });

  it("generate --overwrite replaces an old image format without leaving its sibling", async () => {
    const outDir = path.join(tmp, "format-overwrite");
    const jpg = new Uint8Array(await sharp(png).jpeg().toBuffer());
    providerCalls.generate.mockResolvedValue({
      raw: { data: [{ b64_json: Buffer.from(jpg).toString("base64") }] },
      images: [{ data: jpg }],
    });
    await sdk.generate({ prompt: "jpeg first", outDir, outName: "same" });
    expect(existsSync(path.join(outDir, "same.jpg"))).toBe(true);

    providerCalls.generate.mockResolvedValue({
      raw: { data: [{ b64_json: Buffer.from(png).toString("base64") }] },
      images: [{ data: png }],
    });
    const result = await sdk.generate({
      prompt: "png replacement",
      outDir,
      outName: "same",
      overwrite: true,
    });

    expect(result.files[0]?.path).toBe(path.join(outDir, "same.png"));
    expect(existsSync(path.join(outDir, "same.png"))).toBe(true);
    expect(existsSync(path.join(outDir, "same.jpg"))).toBe(false);
  });

  // A paid response that fills fewer slots than the prior run must still be
  // delivered: the unfilled slots are this run's to clear, not stale siblings.
  it("generate --overwrite delivers a partial response and clears the slots it could not fill", async () => {
    const outDir = path.join(tmp, "partial-overwrite");
    const two = {
      raw: { data: [{ b64_json: "x" }, { b64_json: "x" }] },
      images: [{ data: png }, { data: png }],
    };
    const n2 = { generate: { n: 2 } };
    const shortResponses = [
      { raw: { data: [{ b64_json: "x" }, {}] }, images: [{ data: png }, { data: null, error: "no image" }] },
      { raw: { data: [{ b64_json: "x" }] }, images: [{ data: png }] },
      { raw: { data: [{ b64_json: "x" }, { b64_json: "x" }] }, images: [{ data: png }, { data: new Uint8Array([1, 2, 3]) }] },
    ];
    for (const short of shortResponses) {
      await rm(outDir, { recursive: true, force: true });
      providerCalls.generate.mockResolvedValue(two);
      await sdk.generate({ prompt: "first", outDir, outName: "same", overrides: n2 });

      providerCalls.generate.mockResolvedValue(short);
      const result = await sdk.generate({ prompt: "second", outDir, outName: "same", overrides: n2, overwrite: true });

      expect(result.partial).toBe(short.images.length === 2);
      expect(result.files.map((file) => file.path)).toEqual([path.join(outDir, "same-1.png")]);
      expect((await readdir(outDir)).sort()).toEqual(["same-1.json", "same-1.png"]);
      const sidecar = JSON.parse(await readFile(path.join(outDir, "same-1.json"), "utf-8"));
      expect(sidecar.request.prompt).toBe("second");
    }
  });

  it("generate --overwrite returns partial and keeps the earlier files when every item fails", async () => {
    const outDir = path.join(tmp, "all-failed-overwrite");
    providerCalls.generate.mockResolvedValue({ raw: { data: [{}] }, images: [{ data: png }] });
    await sdk.generate({ prompt: "first", outDir, outName: "same" });

    providerCalls.generate.mockResolvedValue({ raw: { data: [{}] }, images: [{ data: null, error: "no image" }] });
    const result = await sdk.generate({ prompt: "second", outDir, outName: "same", overwrite: true });

    expect(result).toMatchObject({ partial: true, files: [] });
    expect((await readdir(outDir)).sort()).toEqual(["same.json", "same.png"]);
    const sidecar = JSON.parse(await readFile(path.join(outDir, "same.json"), "utf-8"));
    expect(sidecar.request.prompt).toBe("first");
  });

  it("edit --overwrite delivers a partial response and clears the slot it could not fill", async () => {
    const input = path.join(tmp, "partial-edit-input.png");
    const outDir = path.join(tmp, "partial-edit-overwrite");
    await copyFile(fixture("green-disk.png"), input);
    providerCalls.edit.mockResolvedValue({ raw: {}, images: [{ data: png }, { data: png }] });
    await sdk.edit({ prompt: "first", in: input, outDir, outName: "same", overrides: { edit: { n: 2 } } });

    providerCalls.edit.mockResolvedValue({ raw: {}, images: [{ data: png }, { data: null, error: "no image" }] });
    const result = await sdk.edit({
      prompt: "second",
      in: input,
      outDir,
      outName: "same",
      overrides: { edit: { n: 2 } },
      overwrite: true,
    });

    expect(result.partial).toBe(true);
    expect((await readdir(outDir)).sort()).toEqual(["same-1.json", "same-1.png"]);
  });

  it("concurrent calls with default names each publish under their own stem", async () => {
    providerCalls.generate.mockResolvedValue({ raw: { data: [{}] }, images: [{ data: png }] });
    const outDir = path.join(tmp, "concurrent-defaults");
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => sdk.generate({ prompt: `prompt ${i}`, outDir })),
    );
    const stems = new Set(results.map((result) => path.basename(result.files[0]!.path, ".png")));
    expect(stems.size).toBe(8);
    expect((await readdir(outDir)).filter((name) => name.endsWith(".png"))).toHaveLength(8);
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
        overrides: { generate: { n: 2 } },
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
      overrides: { generate: { n: 2 } },
    });

    expect(result.files.map((f) => path.relative(tmp, f.path))).toEqual([
      path.join("output", "two-1.png"),
      path.join("output", "two-2.png"),
    ]);
    // Per-image sidecars: one JSON per image, named to match the image stem.
    expect(result.files.map((f) => path.relative(tmp, f.sidecarPath))).toEqual([
      path.join("output", "two-1.json"),
      path.join("output", "two-2.json"),
    ]);
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
      overrides: { edit: { n: 2 } },
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
        overrides: { edit: { n: 2 } },
      }),
    ).rejects.toMatchObject({ code: "output.exists" });
    expect(existsSync(path.join(outDir, "same-1.png"))).toBe(false);
    expect(existsSync(path.join(outDir, "same-2.png"))).toBe(false);
  });

  it("edit --overwrite replaces an old image format without leaving its sibling", async () => {
    const input = path.join(tmp, "format-edit-input.png");
    const outDir = path.join(tmp, "format-edit-overwrite");
    const jpg = new Uint8Array(await sharp(png).jpeg().toBuffer());
    await copyFile(fixture("green-disk.png"), input);
    providerCalls.edit.mockResolvedValue({ raw: {}, images: [{ data: jpg }] });
    await sdk.edit({ prompt: "jpeg first", in: input, outDir, outName: "same" });

    providerCalls.edit.mockResolvedValue({ raw: {}, images: [{ data: png }] });
    await sdk.edit({
      prompt: "png replacement",
      in: input,
      outDir,
      outName: "same",
      overwrite: true,
    });

    expect(existsSync(path.join(outDir, "same.png"))).toBe(true);
    expect(existsSync(path.join(outDir, "same.jpg"))).toBe(false);
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
      overrides: { edit: { n: 2 } },
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
      overrides: { vision: { shrink: { width: 64, height: 64 }, model: "gpt-6-luna", detail: "high" } },
    });

    expect(result).toMatchObject({
      ok: true,
      score: 0.9,
      reasons: ["looks correct"],
    });
    const call = providerCalls.vision.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      check: "both are green disks",
      params: { model: "gpt-6-luna" },
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

  it("vision rejects an orphan image before a provider charge", async () => {
    const input = path.join(tmp, "vision-orphan-input.png");
    const outDir = path.join(tmp, "vision-orphan-out");
    await copyFile(fixture("green-disk.png"), input);
    await mkdir(outDir);
    await writeFile(path.join(outDir, "same.png"), png);
    providerCalls.vision.mockResolvedValue({
      raw: {},
      verdict: { ok: true, score: 1, reasons: [] },
    });

    await expect(
      sdk.vision({ in: input, check: "must not be charged", outDir, outName: "same" }),
    ).rejects.toMatchObject({ code: "output.exists" });
    expect(providerCalls.vision).not.toHaveBeenCalled();
  });

  it("reserves direct and aliased vision sidecars before a second provider charge", async () => {
    const input = path.join(tmp, "concurrent-vision.png");
    await copyFile(fixture("green-disk.png"), input);
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let providerEntered!: () => void;
    const firstAtProvider = new Promise<void>((resolve) => {
      providerEntered = resolve;
    });
    providerCalls.vision.mockImplementation(async () => {
      providerEntered();
      await firstHeld;
      return {
        raw: { id: "first-vision" },
        verdict: { ok: true, score: 1, reasons: [] },
      };
    });
    const outDir = path.join(tmp, "vision-concurrent-out");
    const aliasDir = path.join(tmp, "vision-concurrent-link");
    await mkdir(outDir);
    await symlink(outDir, aliasDir, process.platform === "win32" ? "junction" : "dir");
    const first = sdk.vision({
      in: input,
      check: "first contender",
      outDir,
      outName: "same",
    });
    await firstAtProvider;

    await expect(
      sdk.vision({ in: input, check: "direct contender", outDir, outName: "same", overwrite: true }),
    ).rejects.toMatchObject({ code: "output.busy" });
    await expect(
      sdk.vision({ in: input, check: "alias contender", outDir: aliasDir, outName: "same", overwrite: true }),
    ).rejects.toMatchObject({ code: "output.busy" });
    expect(providerCalls.vision).toHaveBeenCalledOnce();

    releaseFirst();
    await expect(first).resolves.toMatchObject({ ok: true, score: 1 });
    const sidecar = JSON.parse(await readFile(path.join(outDir, "same.json"), "utf-8"));
    expect(sidecar.request.check).toBe("first contender");
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

  it("sidecars name the model sent, the file actually written and the provider's usage", async () => {
    const webp = new Uint8Array(await sharp(Buffer.from(png)).webp({ quality: 80 }).toBuffer());
    providerCalls.generate.mockResolvedValue({
      raw: {
        data: [{ b64_json: Buffer.from(webp).toString("base64") }],
        output_format: "webp",
        usage: { input_tokens: 9, output_tokens: 196, total_tokens: 205 },
      },
      images: [{ data: webp }],
    });
    providerCalls.edit.mockResolvedValue({ raw: { data: [{ b64_json: "x" }] }, images: [{ data: png }] });
    providerCalls.vision.mockResolvedValue({ raw: {}, verdict: { ok: true, score: 0.9, reasons: ["green"] } });

    const outDir = path.join(tmp, "records");
    const generated = await sdk.generate({
      prompt: "a disk",
      outDir,
      outName: "gen",
      overrides: { generate: { output_format: "webp" } },
    });
    const [file] = generated.files;
    expect(file?.path).toBe(path.join(outDir, "gen.webp"));
    expect(file?.format).toBe("webp");
    expect((await sharp(file!.path).metadata()).format).toBe("webp");
    const sidecar = JSON.parse(await readFile(file!.sidecarPath, "utf-8")) as {
      request: Record<string, unknown>;
      response: { data: Array<{ b64_json: string | null }>; usage: unknown; output_format: string };
      files: Array<{ name: string; sha256: string; format: string }>;
    };
    expect(sidecar.request).toMatchObject({ model: "gpt-image-2.5-flare", output_format: "webp", prompt: "a disk" });
    expect(sidecar.files).toEqual([
      { index: 1, name: "gen.webp", format: "webp", sha256: createHash("sha256").update(await readFile(file!.path)).digest("hex") },
    ]);
    expect(sidecar.response.data[0]?.b64_json).toBeNull();
    expect(sidecar.response.usage).toEqual({ input_tokens: 9, output_tokens: 196, total_tokens: 205 });
    expect(sidecar.response.output_format).toBe("webp");
    const requestLine = lines(await readFile(generated.logPath, "utf-8")).find((line) => line.stage === "request");
    expect(JSON.stringify(requestLine)).toContain('"model":"gpt-image-2.5-flare"');

    const input = path.join(tmp, "edit-input.png");
    await copyFile(fixture("green-disk.png"), input);
    const edited = await sdk.edit({ in: input, prompt: "make it blue", outDir, outName: "edited" });
    const editSidecar = JSON.parse(await readFile(edited.files[0]!.sidecarPath, "utf-8")) as { request: Record<string, unknown> };
    expect(editSidecar.request.model).toBe("gpt-image-2.5-sunburst");
    expect(providerCalls.edit.mock.calls[0]?.[0].params.model).toBe("gpt-image-2.5-sunburst");

    const judged = await sdk.vision({ in: input, check: "is it green?", outDir, outName: "judged" });
    const visionSidecar = JSON.parse(await readFile(judged.sidecarPath, "utf-8")) as { request: Record<string, unknown> };
    expect(visionSidecar.request.model).toBe("gpt-6-luna");
    expect(providerCalls.vision.mock.calls[0]?.[0].params.model).toBe("gpt-6-luna");
  });

  it("generate sends moderation low for a supported model and records it", async () => {
    providerCalls.generate.mockResolvedValue({ raw: { data: [{ b64_json: "x" }] }, images: [{ data: png }] });
    const outDir = path.join(tmp, "moderation");
    for (const model of [undefined, "gpt-image-2.5-sunburst", "gpt-image-2"]) {
      providerCalls.generate.mockClear();
      const outName = `gen-${model ?? "default"}`;
      const result = await sdk.generate({ prompt: "a disk", outDir, outName, overrides: { generate: { model } } });
      expect(providerCalls.generate.mock.calls[0]?.[0].params.moderation, outName).toBe("low");
      const sidecar = JSON.parse(await readFile(result.files[0]!.sidecarPath, "utf-8")) as { request: Record<string, unknown> };
      expect(sidecar.request.moderation, outName).toBe("low");
    }
  });

  it("generate sends an id with no row exactly what the recipe chose, with no moderation", async () => {
    providerCalls.generate.mockResolvedValue({ raw: { data: [{ b64_json: "x" }] }, images: [{ data: png }] });
    const outDir = path.join(tmp, "moderation-unlisted");
    for (const model of ["some-future-image-model", "gpt-image-1.5", "not a model"]) {
      providerCalls.generate.mockClear();
      const chosen = { model, quality: "xhigh", style: "vivid" };
      const outName = `gen-${model.replaceAll(/\W/g, "-")}`;
      const result = await sdk.generate({ prompt: "a disk", outDir, outName, overrides: { generate: chosen } });
      expect(providerCalls.generate.mock.calls[0]?.[0].params, outName).toEqual(chosen);
      const sidecar = JSON.parse(await readFile(result.files[0]!.sidecarPath, "utf-8")) as { request: Record<string, unknown> };
      expect(sidecar.request, outName).not.toHaveProperty("moderation");
    }
  });

  it("edit sends no moderation, for a supported model or any other id", async () => {
    providerCalls.edit.mockResolvedValue({ raw: { data: [{ b64_json: "x" }] }, images: [{ data: png }] });
    const input = path.join(tmp, "edit-moderation.png");
    await copyFile(fixture("green-disk.png"), input);
    const outDir = path.join(tmp, "edit-moderation");
    for (const model of [undefined, "some-future-image-model"]) {
      providerCalls.edit.mockClear();
      const outName = `edit-${model ?? "default"}`;
      await sdk.edit({ in: input, prompt: "make it blue", outDir, outName, overrides: { edit: { model } } });
      expect(providerCalls.edit.mock.calls[0]?.[0].params, outName).not.toHaveProperty("moderation");
    }
  });

  it("generate and edit refuse a recipe that sets moderation, before any provider call", async () => {
    await expect(
      sdk.generate({
        prompt: "a disk",
        outDir: path.join(tmp, "moderation-refused"),
        overrides: { generate: { moderation: "auto" } as never },
      }),
    ).rejects.toMatchObject({ code: "recipe.validationFailed", message: expect.stringContaining("moderation") });
    const input = path.join(tmp, "moderation-refused.png");
    await copyFile(fixture("green-disk.png"), input);
    await expect(
      sdk.edit({
        in: input,
        prompt: "make it blue",
        outDir: path.join(tmp, "moderation-refused"),
        overrides: { edit: { moderation: "low" } as never },
      }),
    ).rejects.toMatchObject({ code: "recipe.validationFailed", message: expect.stringMatching(/^edit section invalid: .*moderation/) });
    expect(providerCalls.generate).not.toHaveBeenCalled();
    expect(providerCalls.edit).not.toHaveBeenCalled();
  });

  it("generate and edit refuse a value the chosen model does not take, before any provider call", async () => {
    const outDir = path.join(tmp, "refused");
    await expect(
      sdk.generate({ prompt: "a disk", outDir, overrides: { generate: { model: "gpt-image-2", quality: "xhigh" } } }),
    ).rejects.toMatchObject({ code: "recipe.validationFailed", message: expect.stringContaining("gpt-image-2 takes quality") });
    const input = path.join(tmp, "refused-input.png");
    await copyFile(fixture("green-disk.png"), input);
    await expect(
      sdk.edit({
        in: input,
        prompt: "make it blue",
        outDir,
        overrides: { edit: { background: "transparent", output_format: "jpeg" } },
      }),
    ).rejects.toMatchObject({ code: "recipe.validationFailed", message: expect.stringContaining("transparent background") });
    expect(providerCalls.generate).not.toHaveBeenCalled();
    expect(providerCalls.edit).not.toHaveBeenCalled();
  });

  it("generate sends a supported model's chosen values as chosen, auto included", async () => {
    providerCalls.generate.mockResolvedValue({ raw: { data: [{ b64_json: "x" }] }, images: [{ data: png }] });
    const chosen = { quality: "auto", background: "opaque", output_format: "jpeg", output_compression: 100, size: "auto" };
    await sdk.generate({ prompt: "a disk", outDir: path.join(tmp, "chosen"), overrides: { generate: chosen } });
    expect(providerCalls.generate.mock.calls[0]?.[0].params).toEqual({
      ...chosen,
      model: "gpt-image-2.5-flare",
      moderation: "low",
    });
  });

  it("vision sends detail auto and the model's own default effort when the recipe sets neither", async () => {
    providerCalls.vision.mockResolvedValue({ raw: {}, verdict: { ok: true, score: 1, reasons: [] } });
    const input = path.join(tmp, "effort.png");
    await copyFile(fixture("green-disk.png"), input);
    const outDir = path.join(tmp, "effort");
    const expected: Array<[string | undefined, string]> = [
      [undefined, "none"],
      ["gpt-6-luna", "none"],
      ["gpt-5.6-terra", "medium"],
      ["gpt-6.1-sol", "medium"],
      ["gpt-6-astra", "medium"],
    ];
    for (const [model, reasoning] of expected) {
      providerCalls.vision.mockClear();
      const outName = `effort-${model ?? "default"}`;
      const result = await sdk.vision({ in: input, check: "green?", outDir, outName, overrides: { vision: { model } } });
      const call = providerCalls.vision.mock.calls[0]?.[0];
      expect(call?.params.reasoning, outName).toBe(reasoning);
      expect(call?.images[0]?.detail, outName).toBe("auto");
      const sidecar = JSON.parse(await readFile(result.sidecarPath, "utf-8")) as { request: Record<string, unknown> };
      expect(sidecar.request.reasoning, outName).toBe(reasoning);
      expect(sidecar.request.detail, outName).toBe("auto");
    }
  });

  it("vision adds neither effort nor detail for an id with no row when the recipe sets neither", async () => {
    providerCalls.vision.mockResolvedValue({ raw: {}, verdict: { ok: true, score: 1, reasons: [] } });
    const input = path.join(tmp, "unlisted-vision.png");
    await copyFile(fixture("green-disk.png"), input);
    const outDir = path.join(tmp, "unlisted-vision");
    for (const model of ["some-future-chat-model", "gpt-5.6-luna"]) {
      providerCalls.vision.mockClear();
      const outName = `unlisted-${model}`;
      const result = await sdk.vision({ in: input, check: "green?", outDir, outName, overrides: { vision: { model } } });
      const call = providerCalls.vision.mock.calls[0]?.[0];
      expect(call?.params, outName).toEqual({ model });
      expect(call?.images[0], outName).not.toHaveProperty("detail");
      const sidecar = JSON.parse(await readFile(result.sidecarPath, "utf-8")) as { request: Record<string, unknown> };
      expect(sidecar.request, outName).not.toHaveProperty("reasoning");
      expect(sidecar.request, outName).not.toHaveProperty("detail");
    }
  });

  it("vision sends an id with no row the recipe's own effort and detail unchanged, and records both", async () => {
    providerCalls.vision.mockResolvedValue({ raw: {}, verdict: { ok: true, score: 1, reasons: [] } });
    const input = path.join(tmp, "unlisted-chosen.png");
    await copyFile(fixture("green-disk.png"), input);
    const outDir = path.join(tmp, "unlisted-chosen");
    for (const model of ["some-future-chat-model", "gpt-5.6-luna"]) {
      providerCalls.vision.mockClear();
      const outName = `chosen-${model}`;
      const result = await sdk.vision({
        in: input,
        check: "green?",
        outDir,
        outName,
        overrides: { vision: { model, reasoning: "anything", detail: "low" } },
      });
      const call = providerCalls.vision.mock.calls[0]?.[0];
      expect(call?.params, outName).toEqual({ model, reasoning: "anything" });
      expect(call?.images[0]?.detail, outName).toBe("low");
      const sidecar = JSON.parse(await readFile(result.sidecarPath, "utf-8")) as { request: Record<string, unknown> };
      expect(sidecar.request.reasoning, outName).toBe("anything");
      expect(sidecar.request.detail, outName).toBe("low");
    }
  });

  it("vision sends a chosen effort, and refuses one the model does not take before any provider call", async () => {
    providerCalls.vision.mockResolvedValue({ raw: {}, verdict: { ok: true, score: 1, reasons: [] } });
    const input = path.join(tmp, "chosen-effort.png");
    await copyFile(fixture("green-disk.png"), input);
    const outDir = path.join(tmp, "chosen-effort");
    await sdk.vision({ in: input, check: "green?", outDir, outName: "high", overrides: { vision: { reasoning: "high" } } });
    expect(providerCalls.vision.mock.calls[0]?.[0].params).toMatchObject({ model: "gpt-6-luna", reasoning: "high" });
    providerCalls.vision.mockClear();
    await expect(
      sdk.vision({ in: input, check: "green?", outDir, outName: "none", overrides: { vision: { model: "gpt-6-astra", reasoning: "none" } } }),
    ).rejects.toMatchObject({ code: "recipe.validationFailed", message: expect.stringContaining("gpt-6-astra takes reasoning") });
    expect(providerCalls.vision).not.toHaveBeenCalled();
  });
  it("vision refuses a recipe that sets reasoning_effort, which the chosen effort would overwrite", async () => {
    // A supported model's branch sends `reasoning` as reasoning_effort, so a passed-through
    // reasoning_effort would be replaced by the model's default without a word.
    const input = path.join(tmp, "wire-effort.png");
    await copyFile(fixture("green-disk.png"), input);
    await expect(
      sdk.vision({
        in: input,
        check: "green?",
        outDir: path.join(tmp, "wire-effort"),
        overrides: { vision: { reasoning_effort: "high" } as never },
      }),
    ).rejects.toMatchObject({ code: "recipe.validationFailed", message: expect.stringContaining("reasoning_effort") });
    expect(providerCalls.vision).not.toHaveBeenCalled();
  });
});
