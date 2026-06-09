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

  it("generate uses the params model and falls back to the provider default", async () => {
    openaiMock.generate.mockResolvedValue({ data: [] });

    await openaiGenerate({
      prompt: "prompt",
      params: { model: "custom-image-model" },
      profile,
      network,
    });
    expect(openaiMock.generate.mock.calls[0]?.[0]).toMatchObject({
      model: "custom-image-model",
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
    expect(Buffer.isBuffer(openaiMock.toFile.mock.calls[0]?.[0])).toBe(true);
    expect(openaiMock.toFile.mock.calls[0]?.[1]).toBe("green-disk.png");
    expect(openaiMock.toFile.mock.calls[0]?.[2]).toEqual({ type: "image/png" });
    expect(Buffer.isBuffer(openaiMock.toFile.mock.calls[1]?.[0])).toBe(true);
    expect(openaiMock.toFile.mock.calls[1]?.[1]).toBe("green-disk.png");
    expect(openaiMock.toFile.mock.calls[1]?.[2]).toEqual({ type: "image/png" });
    expect(openaiMock.edit.mock.calls[0]?.[0]).toMatchObject({
      model: "gpt-image-2",
      prompt: "edit it",
      image: { mockFile: true },
      mask: { mockFile: true },
    });
    expect(openaiMock.edit.mock.calls[0]?.[0]).not.toHaveProperty("response_format");
    expect(result.images[0]?.data).toEqual(png);
  });

  it("edit uses the params model and falls back to the provider default", async () => {
    openaiMock.edit.mockResolvedValue({ data: [] });

    await openaiEdit({
      prompt: "edit it",
      imagePath: path.join(FIXTURES, "green-disk.png"),
      params: { model: "custom-edit-model" },
      profile,
      network,
    });
    expect(openaiMock.edit.mock.calls[0]?.[0]).toMatchObject({
      model: "custom-edit-model",
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
      images: [{ data: png, format: "png", detail: "high" }],
      params: { model: "gpt-5.4-mini" },
      profile,
      network,
    });

    const request = openaiMock.create.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      model: "gpt-5.4-mini",
      response_format: { type: "json_schema" },
    });
    expect(request.messages[1].content[1].image_url.url).toMatch(
      /^data:image\/png;base64,/,
    );
    expect(request.messages[1].content[1].image_url.detail).toBe("high");
    expect(result.verdict).toEqual({
      ok: true,
      score: 0.8,
      reasons: ["green disk visible"],
    });
  });

  it("vision allows detail=original on a compatible model", async () => {
    openaiMock.create.mockResolvedValue({
      choices: [{ message: { content: '{"ok":true,"score":1,"reasons":[]}' } }],
    });

    await openaiVision({
      check: "is it green?",
      images: [{ data: png, format: "png", detail: "original" }],
      params: { model: "gpt-5.4" },
      profile,
      network,
    });

    expect(openaiMock.create.mock.calls[0]?.[0]).toMatchObject({
      model: "gpt-5.4",
    });
    expect(openaiMock.create.mock.calls[0]?.[0].messages[1].content[1].image_url.detail).toBe(
      "original",
    );
  });

  it("vision uses the params model and falls back to the provider default", async () => {
    openaiMock.create.mockResolvedValue({
      choices: [{ message: { content: '{"ok":true,"score":1,"reasons":[]}' } }],
    });

    await openaiVision({
      check: "is it green?",
      images: [{ data: png, format: "png" }],
      params: { model: "custom-vision-model" },
      profile,
      network,
    });
    expect(openaiMock.create.mock.calls[0]?.[0]).toMatchObject({
      model: "custom-vision-model",
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
      model: "gpt-5.4-mini",
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

  it("vision rejects detail=original on mini models before calling the SDK", async () => {
    await expect(
      openaiVision({
        check: "is it green?",
        images: [{ data: png, format: "png", detail: "original" }],
        params: {},
        profile,
        network,
      }),
    ).rejects.toMatchObject({
      errorType: "localOp",
      code: "vision.detailUnsupported",
    });
    expect(openaiMock.create).not.toHaveBeenCalled();
  });

  // A malformed/empty/off-schema response is a provider fault, not a negative
  // verdict — it must surface as a runtime error rather than masquerade as
  // "the image failed the check" (ok: false).
  it("vision throws on an unparseable, empty, or off-schema response", async () => {
    const badContents = [
      "not json", // not valid JSON
      "", // empty response
      JSON.stringify({ ok: true }), // valid JSON, wrong shape
    ];
    for (const content of badContents) {
      openaiMock.create.mockResolvedValueOnce({
        choices: [{ message: { content } }],
      });
      await expect(
        openaiVision({
          check: "is it green?",
          images: [{ data: png, format: "png" }],
          params: {},
          profile,
          network,
        }),
        JSON.stringify(content),
      ).rejects.toMatchObject({
        errorType: "provider",
        code: "provider.invalidResponse",
      });
    }
  });

  it("vision returns a genuine ok:false verdict from the model", async () => {
    openaiMock.create.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              ok: false,
              score: 0.2,
              reasons: ["not green enough"],
            }),
          },
        },
      ],
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
      verdict: { ok: false, score: 0.2, reasons: ["not green enough"] },
    });
  });

  it("vision clamps an out-of-range score from the model", async () => {
    openaiMock.create.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({ ok: true, score: 1.7, reasons: [] }),
          },
        },
      ],
    });
    const result = await openaiVision({
      check: "is it green?",
      images: [{ data: png, format: "png" }],
      params: {},
      profile,
      network,
    });
    expect(result.verdict).toEqual({ ok: true, score: 1, reasons: [] });
  });
});
