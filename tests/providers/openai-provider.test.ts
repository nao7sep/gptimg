import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NETWORK_DEFAULTS } from "../../src/network/defaults.js";
import { openaiEdit } from "../../src/providers/openai/edit.js";
import { openaiGenerate } from "../../src/providers/openai/generate.js";
import { openaiVision } from "../../src/providers/openai/vision.js";
import type { ResolvedProfile } from "../../src/types.js";

const openaiMock = vi.hoisted(() => ({
  generate: vi.fn(),
  edit: vi.fn(),
  create: vi.fn(),
  toFile: vi.fn(async () => ({ mockFile: true })),
}));

vi.mock("openai", () => ({
  default: class OpenAI {
    readonly images = {
      generate: openaiMock.generate,
      edit: openaiMock.edit,
    };
    readonly chat = {
      completions: {
        create: openaiMock.create,
      },
    };
  },
  toFile: openaiMock.toFile,
}));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "..", "fixtures");

const profile: ResolvedProfile = {
  apiKey: "sk-local",
  apiKeySource: "profile.apiKey",
  redacted: { provider: "openai" },
};

const network = {
  primary: { ...NETWORK_DEFAULTS.imageGenerate, retryIntervals: [] },
  download: { ...NETWORK_DEFAULTS.imageDownload, retryIntervals: [] },
};

function pngBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function listen(
  handler: Parameters<typeof createServer>[0],
): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${address.port}/image.png` });
    });
  });
}

describe("OpenAI provider implementations", () => {
  let png: Uint8Array;
  const servers: Server[] = [];

  beforeEach(async () => {
    openaiMock.generate.mockReset();
    openaiMock.edit.mockReset();
    openaiMock.create.mockReset();
    openaiMock.toFile.mockClear();
    png = new Uint8Array(await readFile(path.join(FIXTURES, "green-disk.png")));
  });

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
          }),
      ),
    );
    servers.length = 0;
  });

  it("generate omits response_format for gpt-image models and decodes base64 images", async () => {
    openaiMock.generate.mockResolvedValue({
      data: [{ b64_json: pngBase64(png) }],
    });

    const result = await openaiGenerate({
      prompt: "prompt",
      params: { model: "gpt-image-2", response_format: "url" },
      profile,
      network,
    });

    expect(openaiMock.generate).toHaveBeenCalledWith(
      { model: "gpt-image-2", prompt: "prompt" },
      expect.objectContaining({ maxRetries: 0, signal: undefined }),
    );
    expect(result.images[0]?.data).toEqual(png);
  });

  it("generate falls back to profile model and then provider default model", async () => {
    openaiMock.generate.mockResolvedValue({ data: [] });

    await openaiGenerate({
      prompt: "prompt",
      params: {},
      profile: {
        ...profile,
        redacted: { provider: "openai", model: "profile-image-model" },
      },
      network,
    });
    expect(openaiMock.generate.mock.calls[0]?.[0]).toMatchObject({
      model: "profile-image-model",
    });

    openaiMock.generate.mockClear();
    await openaiGenerate({
      prompt: "prompt",
      params: {},
      profile,
      network,
    });
    expect(openaiMock.generate.mock.calls[0]?.[0]).toMatchObject({
      model: "gpt-image-2",
    });
  });

  it("generate defaults response_format for non-gpt-image models and downloads URL images", async () => {
    const { server, url } = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from(png));
    });
    servers.push(server);
    openaiMock.generate.mockResolvedValue({
      data: [{ url }],
    });

    const result = await openaiGenerate({
      prompt: "prompt",
      params: { model: "dall-e-3" },
      profile,
      network,
    });

    expect(openaiMock.generate.mock.calls[0]?.[0]).toMatchObject({
      model: "dall-e-3",
      response_format: "b64_json",
    });
    expect(result.images[0]?.data).toEqual(png);
  });

  it("generate honors an already-aborted signal before calling the SDK method", async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error("stop"));

    await expect(
      openaiGenerate({
        prompt: "prompt",
        params: {},
        profile,
        network: { ...network, signal: ctrl.signal },
      }),
    ).rejects.toMatchObject({
      name: "AbortError",
      code: "cancelled",
    });
    expect(openaiMock.generate).not.toHaveBeenCalled();
  });

  it("edit passes image and optional mask files and omits response_format for gpt-image models", async () => {
    openaiMock.edit.mockResolvedValue({
      data: [{ b64_json: pngBase64(png) }],
    });

    const result = await openaiEdit({
      prompt: "edit it",
      imagePath: path.join(FIXTURES, "green-disk.png"),
      maskPath: path.join(FIXTURES, "green-disk.png"),
      params: { model: "gpt-image-2", response_format: "url" },
      profile,
      network,
    });

    expect(openaiMock.toFile).toHaveBeenCalledTimes(2);
    expect(openaiMock.edit.mock.calls[0]?.[0]).toMatchObject({
      model: "gpt-image-2",
      prompt: "edit it",
      image: { mockFile: true },
      mask: { mockFile: true },
    });
    expect(openaiMock.edit.mock.calls[0]?.[0]).not.toHaveProperty("response_format");
    expect(result.images[0]?.data).toEqual(png);
  });

  it("edit falls back to profile model and then provider default model", async () => {
    openaiMock.edit.mockResolvedValue({ data: [] });

    await openaiEdit({
      prompt: "edit it",
      imagePath: path.join(FIXTURES, "green-disk.png"),
      params: {},
      profile: {
        ...profile,
        redacted: { provider: "openai", model: "profile-edit-model" },
      },
      network,
    });
    expect(openaiMock.edit.mock.calls[0]?.[0]).toMatchObject({
      model: "profile-edit-model",
    });

    openaiMock.edit.mockClear();
    await openaiEdit({
      prompt: "edit it",
      imagePath: path.join(FIXTURES, "green-disk.png"),
      params: {},
      profile,
      network,
    });
    expect(openaiMock.edit.mock.calls[0]?.[0]).toMatchObject({
      model: "gpt-image-2",
    });
  });

  it("edit honors an already-aborted signal before calling the SDK method", async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error("stop"));

    await expect(
      openaiEdit({
        prompt: "edit it",
        imagePath: path.join(FIXTURES, "green-disk.png"),
        params: {},
        profile,
        network: { ...network, signal: ctrl.signal },
      }),
    ).rejects.toMatchObject({
      name: "AbortError",
      code: "cancelled",
    });
    expect(openaiMock.edit).not.toHaveBeenCalled();
  });

  it("vision sends data URLs and parses structured verdicts", async () => {
    openaiMock.create.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              ok: true,
              score: 0.8,
              reasons: ["green disk visible"],
            }),
          },
        },
      ],
    });

    const result = await openaiVision({
      check: "is it green?",
      images: [{ data: png, format: "png" }],
      params: { model: "gpt-4o-mini" },
      profile,
      network,
    });

    const request = openaiMock.create.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      model: "gpt-4o-mini",
      response_format: { type: "json_schema" },
    });
    expect(request.messages[1].content[1].image_url.url).toMatch(
      /^data:image\/png;base64,/,
    );
    expect(result.verdict).toEqual({
      ok: true,
      score: 0.8,
      reasons: ["green disk visible"],
    });
  });

  it("vision falls back to profile model and then provider default model", async () => {
    openaiMock.create.mockResolvedValue({
      choices: [{ message: { content: '{"ok":true,"score":1,"reasons":[]}' } }],
    });

    await openaiVision({
      check: "is it green?",
      images: [{ data: png, format: "png" }],
      params: {},
      profile: {
        ...profile,
        redacted: { provider: "openai", model: "profile-vision-model" },
      },
      network,
    });
    expect(openaiMock.create.mock.calls[0]?.[0]).toMatchObject({
      model: "profile-vision-model",
    });

    openaiMock.create.mockClear();
    await openaiVision({
      check: "is it green?",
      images: [{ data: png, format: "png" }],
      params: {},
      profile,
      network,
    });
    expect(openaiMock.create.mock.calls[0]?.[0]).toMatchObject({
      model: "gpt-4o-mini",
    });
  });

  it("vision honors an already-aborted signal before calling the SDK method", async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error("stop"));

    await expect(
      openaiVision({
        check: "is it green?",
        images: [{ data: png, format: "png" }],
        params: {},
        profile,
        network: { ...network, signal: ctrl.signal },
      }),
    ).rejects.toMatchObject({
      name: "AbortError",
      code: "cancelled",
    });
    expect(openaiMock.create).not.toHaveBeenCalled();
  });

  it("vision degrades invalid model JSON into a false verdict", async () => {
    openaiMock.create.mockResolvedValue({
      choices: [{ message: { content: "not json" } }],
    });

    const result = await openaiVision({
      check: "is it green?",
      images: [{ data: png, format: "png" }],
      params: {},
      profile,
      network,
    });

    expect(result.verdict).toEqual({
      ok: false,
      score: 0,
      reasons: ["Failed to parse JSON from model response"],
    });
  });

  it("vision degrades empty and schema-mismatched responses", async () => {
    openaiMock.create.mockResolvedValueOnce({
      choices: [{ message: { content: "" } }],
    });
    await expect(
      openaiVision({
        check: "is it green?",
        images: [{ data: png, format: "png" }],
        params: {},
        profile,
        network,
      }),
    ).resolves.toMatchObject({
      verdict: { ok: false, score: 0, reasons: ["Empty response from model"] },
    });

    openaiMock.create.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ ok: true }) } }],
    });
    await expect(
      openaiVision({
        check: "is it green?",
        images: [{ data: png, format: "png" }],
        params: {},
        profile,
        network,
      }),
    ).resolves.toMatchObject({
      verdict: {
        ok: false,
        score: 0,
        reasons: ["Model response did not match the verdict schema"],
      },
    });
  });
});
