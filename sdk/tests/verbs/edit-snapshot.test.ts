import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GptImg } from "../../src/index.ts";
import { done } from "../helpers/results.ts";

let tmp: string;
beforeEach(async () => { tmp = await mkdtemp(path.join(tmpdir(), "gptimg-edit-snapshot-")); });
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(tmp, { recursive: true, force: true });
});
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

it("records the bytes uploaded for both input and mask despite replacement after preparation", async () => {
  const original = await sharp({ create: { width: 2, height: 2, channels: 4, background: "red" } }).png().toBuffer();
  const replacement = await sharp({ create: { width: 2, height: 2, channels: 4, background: "blue" } }).png().toBuffer();
  const input = path.join(tmp, "input.png");
  const mask = path.join(tmp, "mask.png");
  await writeFile(input, original);
  await writeFile(mask, original);
  const uploaded: Record<string, Uint8Array> = {};
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const form = await new Request(url, init).formData();
    for (const field of ["image[]", "image", "mask"]) {
      const file = form.get(field);
      if (file instanceof File) {
        uploaded[field.startsWith("image") ? "input" : "mask"] = new Uint8Array(await file.arrayBuffer());
        expect(file.name).toBe(field === "mask" ? "mask.png" : "input.png");
        expect(file.type).toBe("image/png");
      }
    }
    return new Response(JSON.stringify({ data: [{ b64_json: original.toString("base64") }] }), { headers: { "content-type": "application/json" } });
  }));
  let replaced = false;
  const result = done(await new GptImg({ apiKey: "sk-test" }).edit({ in: input, mask, prompt: "edit", outDir: tmp, outName: "output" }, {
    onEvent(event) {
      if (event.event !== "verb.start") return;
      writeFileSync(input, replacement);
      writeFileSync(mask, replacement);
      replaced = true;
    },
  }));
  expect(replaced).toBe(true);
  expect(Object.keys(uploaded).sort()).toEqual(["input", "mask"]);
  const record = JSON.parse(await readFile(path.join(tmp, "output.json"), "utf8"));
  expect(record.request.inputSha256).toBe(digest(uploaded.input!));
  expect(record.request.maskSha256).toBe(digest(uploaded.mask!));
  expect(uploaded.input).toEqual(new Uint8Array(original));
  expect(uploaded.mask).toEqual(new Uint8Array(original));
  expect(result.failures).toEqual([]);
});

it.each(["input", "mask"] as const)("rejects unreadable %s before a provider request", async (missing) => {
  const input = path.resolve(import.meta.dirname, "../fixtures/green-disk.png");
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(new GptImg({ apiKey: "sk-test" }).edit({
    in: missing === "input" ? path.join(tmp, "missing.png") : input,
    ...(missing === "mask" && { mask: path.join(tmp, "missing.png") }), prompt: "edit", outDir: tmp,
  })).rejects.toMatchObject({ code: "fs.notFound", effect: "none" });
  expect(fetcher).not.toHaveBeenCalled();
});

it("retains unsupported-upload-format rejection before a provider request", async () => {
  const input = path.join(tmp, "input.tiff");
  await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).tiff().toFile(input);
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(new GptImg({ apiKey: "sk-test" }).edit({ in: input, prompt: "edit", outDir: tmp }))
    .rejects.toMatchObject({ code: "image.unsupportedFormat", effect: "none" });
  expect(fetcher).not.toHaveBeenCalled();
});
