import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NETWORK_DEFAULTS } from "../../src/network/defaults.js";
import { OPENAI_MODEL_DEFAULTS } from "../../src/providers/openai/defaults.js";
import { openaiEdit } from "../../src/providers/openai/edit.js";
import { openaiGenerate } from "../../src/providers/openai/generate.js";
import { openaiVision } from "../../src/providers/openai/vision.js";
import type { ResolvedProfile } from "../../src/types.js";

const openaiMock = vi.hoisted(() => ({
  generate: vi.fn(),
  edit: vi.fn(),
  create: vi.fn(),
  toFile: vi.fn(async (_data: unknown, _name?: unknown, _options?: unknown) => ({ mockFile: true })),
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
  handler: RequestListener,
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

  it("generate decodes base64 images", async () => {
    openaiMock.generate.mockResolvedValue({
      data: [{ b64_json: pngBase64(png) }],
    });

    const result = await openaiGenerate({
      prompt: "prompt",
      params: { model: "gpt-image-2" },
      profile,
      network,
    });

    expect(openaiMock.generate).toHaveBeenCalledWith(
      { model: "gpt-image-2", prompt: "prompt" },
      expect.objectContaining({ maxRetries: 0, signal: undefined }),
    );
    expect(result.images[0]?.data).toEqual(png);
  });

  // response_format is neither injected nor stripped. The images endpoint rejects
  // it outright now ("400 Unknown parameter", verified live on gpt-image-2,
  // gpt-image-1.5 and dall-e-3 alike), so a caller who sends one gets the API's
  // refusal rather than a silent edit of their request. Guards both directions:
  // re-adding the old strip, or the old inject-b64_json default.
  it("neither injects nor strips response_format — the API judges it", async () => {
    openaiMock.generate.mockResolvedValue({ data: [{ b64_json: pngBase64(png) }] });

    // A caller's explicit value survives untouched...
    await openaiGenerate({
      prompt: "prompt",
      params: { model: "gpt-image-2", response_format: "url" },
      profile,
      network,
    });
    expect(openaiMock.generate.mock.calls[0]?.[0]).toMatchObject({
      response_format: "url",
    });

    // ...and absence stays absence, for any model.
    openaiMock.generate.mockClear();
    await openaiGenerate({
      prompt: "prompt",
      params: { model: "some-other-image-model" },
      profile,
      network,
    });
    expect(openaiMock.generate.mock.calls[0]?.[0]).not.toHaveProperty("response_format");
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

  // The url branch is kept on its own merit: a response is not ours to predict, and
  // handling one costs nothing. Note this no longer pins a model name — it used to
  // say "dall-e-3", which does not exist any more ("400 The model 'dall-e-3' does
  // not exist"), so the test was describing a path no real call could reach.
  it("downloads the image when the API returns a url instead of base64", async () => {
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
      params: {},
      profile,
      network,
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

  it("edit passes image and optional mask files, and injects no response_format", async () => {
    openaiMock.edit.mockResolvedValue({
      data: [{ b64_json: pngBase64(png) }],
    });

    const result = await openaiEdit({
      prompt: "edit it",
      imagePath: path.join(FIXTURES, "green-disk.png"),
      maskPath: path.join(FIXTURES, "green-disk.png"),
      params: { model: "gpt-image-2" },
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

  it("edit wraps a non-abort SDK failure as a provider.requestFailed error", async () => {
    openaiMock.edit.mockRejectedValue(new Error("upstream 503"));

    await expect(
      openaiEdit({
        prompt: "edit it",
        imagePath: path.join(FIXTURES, "green-disk.png"),
        params: { model: "gpt-image-2" },
        profile,
        network,
      }),
    ).rejects.toMatchObject({
      errorType: "provider",
      code: "provider.requestFailed",
      message: /OpenAI images\.edit failed: upstream 503/,
    });
  });

  it("edit downloads a URL response item and decodes the bytes", async () => {
    const { server, url } = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from(png));
    });
    servers.push(server);
    openaiMock.edit.mockResolvedValue({ data: [{ url }] });

    const result = await openaiEdit({
      prompt: "edit it",
      imagePath: path.join(FIXTURES, "green-disk.png"),
      params: { model: "dall-e-2" },
      profile,
      network,
    });

    expect(result.images[0]?.data).toEqual(png);
    expect(result.images[0]?.error).toBeUndefined();
  });

  it("edit reports a failed URL download as a per-item error without throwing", async () => {
    const { server, url } = await listen((_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("boom");
    });
    servers.push(server);
    openaiMock.edit.mockResolvedValue({ data: [{ url }] });

    const result = await openaiEdit({
      prompt: "edit it",
      imagePath: path.join(FIXTURES, "green-disk.png"),
      params: { model: "dall-e-2" },
      profile,
      network,
    });

    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.data).toBeNull();
    expect(result.images[0]?.error).toMatch(/Failed to fetch image from URL/);
  });

  it("edit reports a response item with neither b64_json nor url as a per-item error", async () => {
    openaiMock.edit.mockResolvedValue({
      data: [{ b64_json: null, url: null }, {}],
    });

    const result = await openaiEdit({
      prompt: "edit it",
      imagePath: path.join(FIXTURES, "green-disk.png"),
      params: { model: "gpt-image-2" },
      profile,
      network,
    });

    expect(result.images).toEqual([
      { data: null, error: "Response item contained neither b64_json nor url" },
      { data: null, error: "Response item contained neither b64_json nor url" },
    ]);
  });

  it("edit rethrows the LocalOpError when the input image cannot be read", async () => {
    const missing = path.join(FIXTURES, "does-not-exist.png");

    await expect(
      openaiEdit({
        prompt: "edit it",
        imagePath: missing,
        params: { model: "gpt-image-2" },
        profile,
        network,
      }),
    ).rejects.toMatchObject({
      errorType: "localOp",
      // Surfaced verbatim from imageFileForEditUpload (upload.ts), not rewrapped.
      code: "image.readFailed",
      message: /Failed to read input image at .*does-not-exist\.png/,
    });
    expect(openaiMock.edit).not.toHaveBeenCalled();
  });

  it("edit rejects an input image whose format is unsupported for upload", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "gptimg-edit-"));
    try {
      const gifPath = path.join(dir, "input.gif");
      const gifBytes = await sharp({
        create: {
          width: 4,
          height: 4,
          channels: 3,
          background: { r: 1, g: 2, b: 3 },
        },
      })
        .gif()
        .toBuffer();
      await writeFile(gifPath, gifBytes);

      await expect(
        openaiEdit({
          prompt: "edit it",
          imagePath: gifPath,
          params: { model: "gpt-image-2" },
          profile,
          network,
        }),
      ).rejects.toMatchObject({
        errorType: "localOp",
        code: "image.formatUnknown",
        message: /Unsupported input image format for OpenAI edit upload: gif/,
      });
      expect(openaiMock.edit).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("edit wraps a non-LocalOpError upload failure as image.readFailed", async () => {
    // toFile (the SDK upload step) is mocked; make it reject with a plain Error
    // so imageFileForEditUpload throws something that is *not* a LocalOpError.
    // edit.ts must wrap that into a LocalOpError("image.readFailed").
    openaiMock.toFile.mockRejectedValueOnce(new Error("toFile blew up"));

    await expect(
      openaiEdit({
        prompt: "edit it",
        imagePath: path.join(FIXTURES, "green-disk.png"),
        params: { model: "gpt-image-2" },
        profile,
        network,
      }),
    ).rejects.toMatchObject({
      errorType: "localOp",
      code: "image.readFailed",
      message: /Failed to read edit input image: toFile blew up/,
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

  // Every VISION_DETAILS value reaches the wire for any model, including the
  // -mini/-nano ids a since-deleted local gate refused detail=original for. That
  // gate was fiction: the API accepts original on gpt-5.4-mini (verified live), and
  // rejects only values outside ['low','auto','high','original'] — its call, not
  // ours. Pinned per value so re-introducing a model-keyed gate fails here.
  it.each(["low", "high", "original", "auto"] as const)(
    "passes detail=%s through untouched, even on a -mini model",
    async (detail) => {
      openaiMock.create.mockResolvedValue({
        choices: [{ message: { content: '{"ok":true,"score":1,"reasons":[]}' } }],
      });

      await openaiVision({
        check: "is it green?",
        images: [{ data: png, format: "png", detail }],
        params: { model: "gpt-5.4-mini" },
        profile,
        network,
      });

      expect(openaiMock.create).toHaveBeenCalledTimes(1);
      expect(
        openaiMock.create.mock.calls[0]?.[0].messages[1].content[1].image_url.detail,
      ).toBe(detail);
    },
  );

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
      model: OPENAI_MODEL_DEFAULTS.vision,
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
