import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GptImg } from "../../src/index.ts";
import { done } from "../helpers/results.ts";

const KEY = "sk-test-diagnostic-sentinel-0123456789";
let tmp: string;
let sdk: GptImg;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "gptimg-diagnostics-"));
  sdk = new GptImg({ apiKey: KEY });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(tmp, { recursive: true, force: true });
});
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

it("masks response-level chat failure diagnostics without an event observer", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({
    id: "resp_failed", status: "failed", error: { code: `error-${KEY}`, message: `Provider explanation ${KEY}` },
  })));
  const failure = await sdk.chat({ message: "draw", outDir: tmp }).catch((err: unknown) => err);
  expect(failure).toMatchObject({ code: "provider.invalidResponse", effect: "unknown" });
  expect(JSON.stringify(failure)).not.toContain(KEY);
  expect((failure as Error).message).toContain("Provider explanation [REDACTED]");
});

it("masks failed image-tool diagnostics while preserving successful chat text", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({
    id: "resp_completed", status: "completed", output: [
      { type: "message", content: [{ type: "output_text", text: `Successful reply ${KEY}` }] },
      { type: "image_generation_call", id: `item-${KEY}`, status: "failed", error: { message: `Tool explanation ${KEY}` } },
      { type: "image_generation_call", id: `blocked-${KEY}`, status: "failed", error: {
        code: "moderation_blocked", message: `Reason ${KEY}`, moderation_details: { categories: [`category-${KEY}`], moderation_stage: `output-${KEY}` },
      } },
    ],
  })));
  const result = done(await sdk.chat({ message: "draw", outDir: tmp }));
  expect(result.text).toBe(`Successful reply ${KEY}`);
  expect(result.failures).toHaveLength(2);
  expect(JSON.stringify(result.failures)).not.toContain(KEY);
  expect(result.failures[0]!.message).toContain("Tool explanation [REDACTED]");
  expect(result.failures[1]!.safeReason).toBe("Reason [REDACTED]");
});

it.each(["generate", "edit"] as const)("masks raw and decoded signed download failures through public %s results", async (verb) => {
  const raw = "signed%2Fvalue+tail%2Bend";
  const decoded = "signed/value tail+end";
  const percentDecoded = "signed/value+tail+end";
  const url = `https://images.example.test/image.png?sig=${raw}`;
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return target === url
      ? new Response(`download denied: raw ${raw}; decoded ${decoded}; percent decoded ${percentDecoded}`, { status: 403 })
      : json({ data: [{ url }] });
  });
  vi.stubGlobal("fetch", fetcher);
  const output = { outDir: tmp, policy: { network: { imageDownload: { maxRetries: 0 } } } };
  const result = done(verb === "generate"
    ? await sdk.generate({ prompt: "draw", ...output })
    : await sdk.edit({ in: path.resolve(import.meta.dirname, "../fixtures/green-disk.png"), prompt: "edit", ...output }));
  expect(result.failures).toHaveLength(1);
  const diagnostics = JSON.stringify(result.failures);
  expect(diagnostics).not.toContain(raw);
  expect(diagnostics).not.toContain(decoded);
  expect(diagnostics).not.toContain(percentDecoded);
  expect(diagnostics).toContain("download denied");
  expect(diagnostics).toContain("[REDACTED]");
  expect(fetcher.mock.calls.filter(([input]) => String(input).startsWith("https:"))).toHaveLength(2);
  // The live download must still receive the signed URL, exactly as returned.
  expect(fetcher.mock.calls.some(([input]) => String(input) === url)).toBe(true);
});

it("preserves signed URLs when a download succeeds", async () => {
  const png = await readFile(path.resolve(import.meta.dirname, "../fixtures/green-disk.png"));
  const url = "https://images.example.test/image.png?sig=signed%2Fvalue+tail%2Bend";
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
    String(input) === url ? new Response(png) : json({ data: [{ url }] })));
  const result = done(await sdk.generate({ prompt: "draw", outDir: tmp }));
  expect(result.failures).toEqual([]);
  expect(await readFile(result.files[0]!.path)).toEqual(png);
});
