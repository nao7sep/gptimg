// What a paid call spent stays with its result: the provider's response, with
// its token usage, is on every completed generate or edit result, also when no
// image was published, and on a refusal that arrived in a paid answer.
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GptImg } from "../../src/gptimg.ts";
import type { Provider } from "../../src/providers/types.ts";
import { RefusalSignal } from "../../src/refusal.ts";
import { done } from "../helpers/results.ts";

const provider = vi.hoisted(() => ({ generate: vi.fn(), edit: vi.fn(), vision: vi.fn(), chat: vi.fn() }));
vi.mock("../../src/providers/index.ts", () => ({
  getProvider: (): Provider => ({ name: "openai", ...provider }),
}));

const USAGE = { input_tokens: 12, output_tokens: 4160, input_tokens_details: { text_tokens: 12, image_tokens: 0 } };

describe("what a paid call spent", () => {
  let tmp: string;
  let outDir: string;
  let png: Buffer;
  let sdk: GptImg;

  beforeEach(async () => {
    for (const fn of Object.values(provider)) fn.mockReset();
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-paid-usage-"));
    outDir = path.join(tmp, "out");
    await mkdir(outDir);
    png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#336699" } }).png().toBuffer();
    sdk = new GptImg({ apiKey: "sk-disposable-test" });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("keeps the response and its usage when the provider returned no image, reporting each requested one", async () => {
    provider.generate.mockResolvedValue({ raw: { created: 1, data: [], usage: USAGE }, images: [] });
    const result = done(await sdk.generate({ prompt: "x", outDir, policy: { generate: { n: 2 } } }));
    expect(result.files).toEqual([]);
    expect(result.failures).toEqual([
      expect.objectContaining({ index: 1, code: "provider.noImage", effect: "unknown" }),
      expect.objectContaining({ index: 2, code: "provider.noImage", effect: "unknown" }),
    ]);
    expect(result.response).toMatchObject({ usage: USAGE });
    expect(await readdir(outDir)).toEqual([]);
  });

  it("keeps the response when an output that appeared during the call stops every image", async () => {
    provider.generate.mockImplementation(async () => {
      await writeFile(path.join(outDir, "taken.png"), "someone else's");
      return { raw: { data: [{ b64_json: "AAAA" }], usage: USAGE }, images: [{ data: png }] };
    });
    const result = done(await sdk.generate({ prompt: "x", outDir, outName: "taken" }));
    expect(result.files).toEqual([]);
    expect(result.failures).toEqual([expect.objectContaining({ index: 1, code: "output.exists" })]);
    expect(result.response).toMatchObject({ usage: USAGE, data: [{ b64_json: null }] });
  });

  it("gives a published run the same response its records hold", async () => {
    provider.generate.mockResolvedValue({ raw: { data: [{ b64_json: "AAAA" }], usage: USAGE }, images: [{ data: png }] });
    const result = done(await sdk.generate({ prompt: "x", outDir, outName: "kept" }));
    expect(result.files).toHaveLength(1);
    expect(result.response).toEqual(result.files[0]!.record.response);
  });

  it("keeps the paid answer on a refused vision result", async () => {
    const input = path.join(tmp, "in.png");
    await writeFile(input, png);
    provider.vision.mockImplementation(async () => {
      const signal = new RefusalSignal({ code: "provider.refused", message: "declined", safeReason: "no" });
      signal.response = { usage: { prompt_tokens: 85, completion_tokens: 9 } };
      throw signal;
    });
    await expect(sdk.vision({ in: input, check: "x" })).resolves.toMatchObject({
      status: "refused",
      refusal: { code: "provider.refused" },
      response: { usage: { prompt_tokens: 85, completion_tokens: 9 } },
    });
  });
});
