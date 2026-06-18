import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AbortError, GptImg } from "../../src/index.js";
import { callWithRetry } from "../../src/network/retry.js";
import { obfuscate } from "../../src/profile/obfuscate.js";
import type { Provider } from "../../src/providers/types.js";
import type {
  GenerateProviderArgs,
  EditProviderArgs,
  VisionProviderArgs,
  ProviderImageResult,
  ProviderVisionResult,
} from "../../src/providers/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "..", "fixtures");

function fixture(name: string): string {
  return path.join(FIXTURES, name);
}

describe("SDK abort errors", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-abort-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("rejects with the exported AbortError shape", async () => {
    const sdk = new GptImg({ profileDir: tmp, logDir: tmp });
    const ctrl = new AbortController();
    ctrl.abort(new Error("stop"));

    await expect(
      sdk.mask(
        {
          in: fixture("green-disk.png"),
          log: path.join(tmp, "mask.log"),
        },
        { signal: ctrl.signal },
      ),
    ).rejects.toMatchObject({
      name: "AbortError",
      errorType: "abort",
      code: "cancelled",
      message: "stop",
    });

    await expect(
      sdk.mask(
        {
          in: fixture("green-disk.png"),
          log: path.join(tmp, "mask-2.log"),
        },
        { signal: ctrl.signal },
      ),
    ).rejects.toBeInstanceOf(AbortError);
  });
});

// The AI verbs (generate/edit/vision) thread `opts.signal` into the provider's
// `network.signal`; the real provider observes it through `callWithRetry`,
// which throws the AbortError shape `toAbortError` produces. These tests use a
// provider mock that routes `args.network.signal` (and the primary budget)
// through the real `callWithRetry` exactly as the OpenAI provider does, so the
// verb-level abort path is exercised end to end rather than faked. With an
// already-aborted signal `callWithRetry` rejects before the inner call; with a
// signal aborted mid-call the inner call observes it and the same shape surfaces.
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

describe("AI verb abort propagation", () => {
  let tmp: string;
  let sdk: GptImg;

  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("OPENAI_API_KEY", undefined);
    providerCalls.generate.mockReset();
    providerCalls.edit.mockReset();
    providerCalls.vision.mockReset();

    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-ai-abort-"));
    sdk = new GptImg({ profileDir: tmp, logDir: path.join(tmp, "logs") });
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

  // Mirror how the real provider observes the signal: run the (would-be)
  // request through `callWithRetry` with the budget and signal it was handed.
  // `inner` only runs once the abort gate passes, so it never executes when the
  // signal is already aborted.
  function viaRetry<T>(
    network: GenerateProviderArgs["network"],
    inner: () => Promise<T>,
  ): Promise<T> {
    return callWithRetry(
      {
        budgetName: "imageGenerate",
        budget: network.primary,
        signal: network.signal,
        logger: network.logger,
      },
      inner,
    );
  }

  const ABORT_SHAPE = {
    name: "AbortError",
    errorType: "abort",
    code: "cancelled",
    message: "stop",
  };

  // Mirror a real signal-aware request: the in-flight call rejects when the
  // signal fires (as `fetch`/the OpenAI client would), which `callWithRetry`
  // catches and converts into the AbortError shape. The mock aborts the
  // controller itself to stand in for an external mid-call cancellation.
  function abortMidCall(ctrl: AbortController, signal: AbortSignal | undefined): Promise<never> {
    ctrl.abort(new Error("stop"));
    return new Promise<never>((_resolve, reject) => {
      if (signal?.aborted) {
        const err = new Error(String(signal.reason));
        err.name = "AbortError";
        reject(err);
        return;
      }
      signal?.addEventListener(
        "abort",
        () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        },
        { once: true },
      );
    });
  }

  it("generate rejects with the AbortError shape when the signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error("stop"));
    let innerRan = false;
    providerCalls.generate.mockImplementation(
      (args: GenerateProviderArgs): Promise<ProviderImageResult> =>
        viaRetry(args.network, async () => {
          innerRan = true;
          return { raw: { data: [] }, images: [] };
        }),
    );

    await expect(
      sdk.generate(
        { prompt: "a green disk", outDir: path.join(tmp, "out"), outName: "gen" },
        { signal: ctrl.signal },
      ),
    ).rejects.toMatchObject(ABORT_SHAPE);
    await expect(
      sdk.generate(
        { prompt: "a green disk", outDir: path.join(tmp, "out2"), outName: "gen" },
        { signal: ctrl.signal },
      ),
    ).rejects.toBeInstanceOf(AbortError);
    expect(innerRan).toBe(false);
  });

  it("generate rejects with the AbortError shape when the signal aborts mid-call", async () => {
    const ctrl = new AbortController();
    providerCalls.generate.mockImplementation(
      (args: GenerateProviderArgs): Promise<ProviderImageResult> =>
        viaRetry(args.network, () => abortMidCall(ctrl, args.network.signal)),
    );

    await expect(
      sdk.generate(
        { prompt: "a green disk", outDir: path.join(tmp, "out"), outName: "gen" },
        { signal: ctrl.signal },
      ),
    ).rejects.toMatchObject(ABORT_SHAPE);
  });

  it("edit rejects with the AbortError shape when the signal is already aborted", async () => {
    const input = path.join(tmp, "input.png");
    await copyFile(fixture("green-disk.png"), input);
    const ctrl = new AbortController();
    ctrl.abort(new Error("stop"));
    let innerRan = false;
    providerCalls.edit.mockImplementation(
      (args: EditProviderArgs): Promise<ProviderImageResult> =>
        viaRetry(args.network, async () => {
          innerRan = true;
          return { raw: { data: [] }, images: [] };
        }),
    );

    await expect(
      sdk.edit(
        { prompt: "make it blue", in: input, outDir: path.join(tmp, "edits"), outName: "edit" },
        { signal: ctrl.signal },
      ),
    ).rejects.toMatchObject(ABORT_SHAPE);
    expect(innerRan).toBe(false);
  });

  it("edit rejects with the AbortError shape when the signal aborts mid-call", async () => {
    const input = path.join(tmp, "input.png");
    await copyFile(fixture("green-disk.png"), input);
    const ctrl = new AbortController();
    providerCalls.edit.mockImplementation(
      (args: EditProviderArgs): Promise<ProviderImageResult> =>
        viaRetry(args.network, () => abortMidCall(ctrl, args.network.signal)),
    );

    await expect(
      sdk.edit(
        { prompt: "make it blue", in: input, outDir: path.join(tmp, "edits"), outName: "edit" },
        { signal: ctrl.signal },
      ),
    ).rejects.toMatchObject(ABORT_SHAPE);
  });

  it("vision rejects with the AbortError shape when the signal is already aborted", async () => {
    const input = path.join(tmp, "single.png");
    await copyFile(fixture("green-disk.png"), input);
    const ctrl = new AbortController();
    ctrl.abort(new Error("stop"));
    let innerRan = false;
    providerCalls.vision.mockImplementation(
      (args: VisionProviderArgs): Promise<ProviderVisionResult> =>
        viaRetry(args.network, async () => {
          innerRan = true;
          return { raw: {}, verdict: { ok: true, score: 1, reasons: [] } };
        }),
    );

    await expect(
      sdk.vision(
        { in: input, check: "is it green?", outDir: path.join(tmp, "vision-out"), outName: "vision" },
        { signal: ctrl.signal },
      ),
    ).rejects.toMatchObject(ABORT_SHAPE);
    expect(innerRan).toBe(false);
  });

  it("vision rejects with the AbortError shape when the signal aborts mid-call", async () => {
    const input = path.join(tmp, "single.png");
    await copyFile(fixture("green-disk.png"), input);
    const ctrl = new AbortController();
    providerCalls.vision.mockImplementation(
      (args: VisionProviderArgs): Promise<ProviderVisionResult> =>
        viaRetry(args.network, () => abortMidCall(ctrl, args.network.signal)),
    );

    await expect(
      sdk.vision(
        { in: input, check: "is it green?", outDir: path.join(tmp, "vision-out"), outName: "vision" },
        { signal: ctrl.signal },
      ),
    ).rejects.toMatchObject(ABORT_SHAPE);
  });
});
