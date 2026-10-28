// A chat turn through the real OpenAI client against the SDK's own stand-in:
// drafts streamed while an image is drawn, a mask sent with the first image,
// blocked images told apart from missing ones, and a stream that drops,
// stalls or is cancelled settling with the effect it had.
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GptImg } from "../../src/gptimg.ts";
import { NETWORK_DEFAULTS } from "../../src/network/index.ts";
import { startOpenAIDouble, type OpenAIDouble } from "../../src/testing/index.ts";
import type { PartialImage } from "../../src/types.ts";
import { done } from "../helpers/results.ts";

let openai: OpenAIDouble;
let tmp: string;
let img: GptImg;

beforeEach(async () => {
  openai = await startOpenAIDouble();
  tmp = await mkdtemp(path.join(tmpdir(), "gptimg-chat-double-"));
  img = new GptImg({ apiKey: "sk-double", baseURL: openai.baseURL });
});

afterEach(async () => {
  await openai.close();
  await rm(tmp, { recursive: true, force: true });
});

const body = (i = 0) => openai.requests[i]!.body as Record<string, unknown> & { tools: Record<string, unknown>[] };

describe("drafts while an image is drawn", () => {
  it("streams the turn, hands each draft over numbered by image, and saves only the finished images", async () => {
    openai.reply({ kind: "success", images: 2 });
    const drafts: PartialImage[] = [];
    const result = done(
      await img.chat(
        { message: "two foxes", outDir: tmp, outName: "turn", policy: { chat: { partial_images: 2 } } },
        { onPartialImage: (draft) => drafts.push(draft) },
      ),
    );
    expect(body()).toMatchObject({ stream: true, tools: [{ type: "image_generation", partial_images: 2 }] });
    expect(drafts.map((d) => [d.image, d.index])).toEqual([[0, 0], [0, 1], [1, 0], [1, 1]]);
    expect(drafts[0]!.format).toBe("png");
    expect((await sharp(Buffer.from(drafts[0]!.data)).metadata()).width).toBe(64);
    expect(result.files).toHaveLength(2);
    expect((await readdir(tmp)).sort()).toEqual(["turn-1.json", "turn-1.png", "turn-2.json", "turn-2.png"]);
  });

  it("does not stream without drafts, and a throwing hook never breaks the turn", async () => {
    done(await img.chat({ message: "a fox", outDir: tmp, outName: "plain" }));
    expect(body(0).stream).toBeUndefined();
    expect(body(0).tools[0]!.partial_images).toBeUndefined();
    const result = done(
      await img.chat(
        { message: "a fox", outDir: tmp, outName: "hooked", policy: { chat: { partial_images: 1 } } },
        {
          onPartialImage: () => {
            throw new Error("the caller's bug");
          },
        },
      ),
    );
    expect(result.files).toHaveLength(1);
  });

  it("refuses a draft count OpenAI does not take", async () => {
    await expect(img.chat({ message: "x", outDir: tmp, policy: { chat: { partial_images: 4 } } })).rejects.toMatchObject({ code: "policy.invalid" });
  });

  it("settles a dropped stream as a network failure that may have been paid, without resending", async () => {
    openai.reply({ kind: "streamDropped", afterDrafts: 1 });
    const drafts: PartialImage[] = [];
    await expect(
      img.chat({ message: "a fox", outDir: tmp, policy: { chat: { partial_images: 2 } } }, { onPartialImage: (d) => drafts.push(d) }),
    ).rejects.toMatchObject({ effect: "unknown" });
    expect(drafts).toHaveLength(1);
    expect(openai.requests).toHaveLength(1);
    expect(await readdir(tmp)).toEqual([]);
  });

  it("settles a stream that goes silent as a timeout that may have been paid", async () => {
    openai.reply({ kind: "streamStalled" });
    let drawn!: () => void;
    const firstDraft = new Promise<void>((resolve) => (drawn = resolve));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const turn = img.chat(
        { message: "a fox", outDir: tmp, policy: { chat: { partial_images: 1 }, network: { chat: { maxRetries: 0 } } } },
        { onPartialImage: () => drawn() },
      );
      const rejected = expect(turn).rejects.toMatchObject({ code: "provider.timeout", effect: "unknown" });
      await firstDraft;
      await vi.advanceTimersByTimeAsync(NETWORK_DEFAULTS.chat.timeout);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
    expect(openai.requests).toHaveLength(1);
  });

  it("cancels a streaming turn after its first draft, the work possibly accepted", async () => {
    openai.reply({ kind: "streamStalled" });
    const controller = new AbortController();
    const turn = img.chat(
      { message: "a fox", outDir: tmp, policy: { chat: { partial_images: 1 } } },
      { signal: controller.signal, onPartialImage: () => controller.abort() },
    );
    await expect(turn).rejects.toMatchObject({ code: "cancelled", effect: "unknown" });
    expect(await readdir(tmp)).toEqual([]);
  });
});

describe("blocked images", () => {
  it("reports a moderation block as such, apart from the images that were saved", async () => {
    openai.reply({ kind: "success", images: 1, blockedImages: 2 });
    const result = done(await img.chat({ message: "two more", outDir: tmp, outName: "turn" }));
    expect(result.files).toHaveLength(1);
    expect(result.failures.map((f) => f.code)).toEqual(["provider.moderationBlocked", "provider.moderationBlocked"]);
    expect(result.failures[0]!.message).toContain("(sexual, judged on the output)");
    expect(result.failures[0]!.safeReason).toBe("Your request was rejected by the safety system.");
    expect(result.recordPublication).toBeNull();
    expect(result.usage).toMatchObject({ input: expect.any(Number), output: expect.any(Number) });
  });

  it("says whether a turn's record was written when it produced no image", async () => {
    openai.reply({ kind: "success", images: 0 });
    const saved = done(await img.chat({ message: "just words", outDir: tmp, outName: "words" }));
    expect(saved.recordPublication).toEqual({ status: "published" });
    expect(saved.recordPath).toBe(path.join(tmp, "words.json"));
  });
});

describe("a mask", () => {
  const picture = (width: number, height: number, alpha: boolean) =>
    sharp({ create: { width, height, channels: alpha ? 4 : 3, background: alpha ? { r: 0, g: 0, b: 0, alpha: 0 } : "#000" } }).png().toBuffer();

  it("goes with the first image as the image tool's input_image_mask", async () => {
    const image = path.join(tmp, "photo.png");
    const mask = path.join(tmp, "mask.png");
    await writeFile(image, await picture(80, 40, false));
    await writeFile(mask, await picture(80, 40, true));
    const result = done(await img.chat({ message: "a hat", images: [image], mask, outDir: tmp, outName: "turn" }));
    expect(body().tools[0]!.input_image_mask).toMatchObject({ image_url: expect.stringMatching(/^data:image\/png;base64,/) });
    expect(result.files).toHaveLength(1);
  });

  it("is sent in OpenAI's documented form: kept opaque white, transparent black where the image may change", async () => {
    const image = path.join(tmp, "photo.png");
    const mask = path.join(tmp, "mask.png");
    await writeFile(image, await picture(80, 40, false));
    // Opaque black where nothing may change, a transparent left half: the shape that came back blacked out.
    const hole = await sharp({ create: { width: 40, height: 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
    await writeFile(
      mask,
      await sharp({ create: { width: 80, height: 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } })
        .composite([{ input: hole, left: 0, top: 0, blend: "dest-out" }])
        .png()
        .toBuffer(),
    );
    done(await img.chat({ message: "a hat", images: [image], mask, outDir: tmp, outName: "turn" }));
    const sent = (body().tools[0]!.input_image_mask as { image_url: string }).image_url.split(",")[1]!;
    const { data } = await sharp(Buffer.from(sent, "base64")).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number) => [...data.subarray((10 * 80 + x) * 4, (10 * 80 + x) * 4 + 4)];
    expect(pixel(10)).toEqual([0, 0, 0, 0]);
    expect(pixel(60)).toEqual([255, 255, 255, 255]);
  });

  it("is shown to the assistant too: the area's bounds in words, then the mask, opaque and at low detail", async () => {
    const image = path.join(tmp, "photo.png");
    const mask = path.join(tmp, "mask.png");
    await writeFile(image, await picture(80, 40, false));
    const hole = await sharp({ create: { width: 40, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
    await writeFile(
      mask,
      await sharp({ create: { width: 80, height: 40, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
        .composite([{ input: hole, left: 40, top: 0, blend: "dest-out" }])
        .png()
        .toBuffer(),
    );
    done(await img.chat({ message: "a bird here", images: [image], mask, outDir: tmp, outName: "turn" }));
    const content = (body().input as { role: string; content: Record<string, string>[] }[]).at(-1)!.content;
    expect(content.map((c) => c.type)).toEqual(["input_text", "input_image", "input_text", "input_image"]);
    expect(content[2]!.text).toContain("from 50% to 100% across and 0% to 50% down");
    expect(content[3]!.detail).toBe("low");
    const guide = await sharp(Buffer.from(content[3]!.image_url!.split(",")[1]!, "base64")).raw().toBuffer({ resolveWithObject: true });
    expect(guide.info.channels).toBe(3);
    expect([...guide.data.subarray(0, 3)]).toEqual([255, 255, 255]);
    const inHole = (5 * guide.info.width + 60) * 3;
    expect([...guide.data.subarray(inHole, inHole + 3)]).toEqual([0, 0, 0]);
  });

  it("is checked before paying: an image to apply to, a PNG of the same size, with transparency", async () => {
    const image = path.join(tmp, "photo.png");
    await writeFile(image, await picture(80, 40, false));
    const wrongSize = path.join(tmp, "small.png");
    await writeFile(wrongSize, await picture(40, 40, true));
    const opaque = path.join(tmp, "opaque.png");
    await writeFile(opaque, await picture(80, 40, false));
    const jpeg = path.join(tmp, "mask.jpg");
    await writeFile(jpeg, await sharp({ create: { width: 80, height: 40, channels: 3, background: "#000" } }).jpeg().toBuffer());

    await expect(img.chat({ message: "x", mask: wrongSize, outDir: tmp })).rejects.toMatchObject({ code: "args.invalid", details: { field: "mask" } });
    await expect(img.chat({ message: "x", images: [image], mask: wrongSize, outDir: tmp })).rejects.toMatchObject({
      code: "args.invalid",
      message: expect.stringContaining("40x40, but the first image is 80x40"),
    });
    await expect(img.chat({ message: "x", images: [image], mask: opaque, outDir: tmp })).rejects.toMatchObject({ details: { constraint: "transparency" } });
    await expect(img.chat({ message: "x", images: [image], mask: jpeg, outDir: tmp })).rejects.toMatchObject({ details: { constraint: "a PNG" } });
    await expect(img.chat({ message: "x", images: [image], mask: "mask.png", outDir: tmp })).rejects.toMatchObject({ code: "args.invalid" });
    expect(openai.requests).toHaveLength(0);
  });
});
