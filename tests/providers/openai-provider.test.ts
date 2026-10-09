import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modelsFor } from "../../src/ai-models.js";
import { createLogger, type Logger } from "../../src/log/index.js";
import { NETWORK_DEFAULTS } from "../../src/network/defaults.js";
import { openaiEdit } from "../../src/providers/openai/edit.js";
import { openaiGenerate } from "../../src/providers/openai/generate.js";
import { OPENAI_VISION_SYSTEM_PROMPT } from "../../src/providers/openai/defaults.js";
import { openaiVision } from "../../src/providers/openai/vision.js";
import type { LogVerb, ResolvedProfile } from "../../src/types.js";

const openaiMock = vi.hoisted(() => ({
  generate: vi.fn(),
  edit: vi.fn(),
  create: vi.fn(),
  toFile: vi.fn(async (_data: unknown, _name?: unknown, _options?: unknown) => ({ mockFile: true })),
}));

// The SDK's APIPromise: the parsed body, with `withResponse()` adding the HTTP
// response and its request id.
function apiPromise(call: (...args: unknown[]) => unknown) {
  return (...args: unknown[]) => {
    const body = Promise.resolve(call(...args));
    return Object.assign(body, {
      withResponse: async () => ({
        data: await body,
        response: new Response(null, { status: 200, headers: { "x-request-id": "req_test" } }),
        request_id: "req_test",
      }),
    });
  };
}

vi.mock("openai", () => ({
  default: class OpenAI {
    readonly apiKey: string;
    readonly organization: string | null;
    readonly project: string | null;
    constructor(opts: { apiKey: string; organization?: string; project?: string }) {
      this.apiKey = opts.apiKey;
      this.organization = opts.organization ?? null;
      this.project = opts.project ?? null;
    }
    readonly images = {
      generate: apiPromise(openaiMock.generate),
      edit: apiPromise(openaiMock.edit),
    };
    readonly chat = {
      completions: {
        create: apiPromise(openaiMock.create),
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
    expect(Buffer.from(result.images[0]!.data!).equals(Buffer.from(png))).toBe(true);
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
      model: "gpt-image-2.5-flare",
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

    expect(Buffer.from(result.images[0]!.data!).equals(Buffer.from(png))).toBe(true);
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
    expect(Buffer.from(result.images[0]!.data!).equals(Buffer.from(png))).toBe(true);
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
      model: "gpt-image-2.5-sunburst",
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

    expect(Buffer.from(result.images[0]!.data!).equals(Buffer.from(png))).toBe(true);
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

  // A refusal comes back as a `refusal` string with null content. Reading `content` alone
  // reports a parse failure and hides the model's stated reason — the caller cannot then tell
  // "declined" from "answered in a shape we could not read", and only the first is the user's
  // to act on. `length` is quieter still: the content is present and reads like a full verdict.
  // (ai-model-routing-conventions: never invent a cause the provider gave you.)
  it.each([
    ["a refusal", { finish_reason: "stop", message: { content: null, refusal: "I can't assess that." } }, /declined to verify this image: I can't assess that\./, "provider.refused"],
    ["a content filter", { finish_reason: "content_filter", message: { content: null } }, /content filter rejected/, "provider.contentFiltered"],
    ["a truncated verdict", { finish_reason: "length", message: { content: '{"ok":true,"score":1,' } }, /truncated/, "provider.truncated"],
  ])("reports %s with the provider's own reason and a distinct code", async (_label, choice, expected, expectedCode) => {
    openaiMock.create.mockResolvedValue({ choices: [choice] });
    const call = openaiVision({
      check: "is it green?",
      images: [{ data: png, format: "png", detail: "auto" }],
      params: { model: "gpt-6-luna" },
      profile,
      network,
    });
    await expect(call).rejects.toThrow(expected);
    // Each outcome needs its own code so a caller can branch on "change the
    // input" vs. "raise max tokens" without parsing message text; all three
    // sharing the provider's name ("openai") would make that impossible.
    await expect(call).rejects.toMatchObject({ code: expectedCode });
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
      params: { model: "gpt-6-luna" },
      profile,
      network,
    });

    const request = openaiMock.create.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      model: "gpt-6-luna",
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

  // Every VISION_DETAILS value reaches the wire as given on every supported vision row;
  // "original" was tested on all four (ai-model-lineup-20261004). Pinned per value and
  // row so a model-keyed gate on detail fails here.
  it.each(["low", "high", "original", "auto"] as const)(
    "passes detail=%s through untouched on every supported vision model",
    async (detail) => {
      openaiMock.create.mockResolvedValue({
        choices: [{ message: { content: '{"ok":true,"score":1,"reasons":[]}' } }],
      });

      for (const model of modelsFor("openai", "vision").map((row) => row.id)) {
        openaiMock.create.mockClear();
        await openaiVision({
          check: "is it green?",
          images: [{ data: png, format: "png", detail }],
          params: { model },
          profile,
          network,
        });

        expect(openaiMock.create).toHaveBeenCalledTimes(1);
        expect(
          openaiMock.create.mock.calls[0]?.[0].messages[1].content[1].image_url.detail,
          model,
        ).toBe(detail);
      }
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
      model: "gpt-6-luna",
    });
  });

  it("vision sends a supported model's effort as reasoning_effort, its own default when unset", async () => {
    openaiMock.create.mockResolvedValue({
      choices: [{ message: { content: '{"ok":true,"score":1,"reasons":[]}' } }],
    });
    const cases: Array<[Record<string, unknown>, string | undefined]> = [
      [{}, "none"],
      [{ model: "gpt-6-astra" }, "medium"],
      [{ model: "gpt-5.6-terra", reasoning: "none" }, "none"],
      [{ model: "gpt-6-luna", reasoning: "max" }, "max"],
      [{ model: "gpt-5.6-sol" }, undefined],
      [{ model: "custom-vision-model" }, undefined],
      [{ model: "custom-vision-model", reasoning: "low" }, "low"],
    ];
    for (const [params, effort] of cases) {
      openaiMock.create.mockClear();
      await openaiVision({ check: "is it green?", images: [{ data: png, format: "png" }], params, profile, network });
      const request = openaiMock.create.mock.calls[0]?.[0];
      expect(request.reasoning_effort, JSON.stringify(params)).toBe(effort);
      expect(request, JSON.stringify(params)).not.toHaveProperty("reasoning");
      expect(request.response_format.json_schema.strict).toBe(true);
    }
  });

  it("vision sends an id with no row exactly the plain request when the caller sets nothing", async () => {
    openaiMock.create.mockResolvedValue({
      choices: [{ message: { content: '{"ok":true,"score":1,"reasons":[]}' } }],
    });
    await openaiVision({
      check: "is it green?",
      images: [{ data: png, format: "png" }],
      params: { model: "some-future-chat-model" },
      profile,
      network,
    });
    const request = openaiMock.create.mock.calls[0]?.[0];
    expect(request).toEqual({
      model: "some-future-chat-model",
      messages: [
        { role: "system", content: expect.any(String) },
        {
          role: "user",
          content: [
            { type: "text", text: "is it green?" },
            { type: "image_url", image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) } },
          ],
        },
      ],
      response_format: { type: "json_schema", json_schema: expect.objectContaining({ name: "VisionVerdict", strict: true }) },
    });
  });

  it("vision sends an id with no row the caller's own detail and effort unchanged", async () => {
    openaiMock.create.mockResolvedValue({
      choices: [{ message: { content: '{"ok":true,"score":1,"reasons":[]}' } }],
    });
    await openaiVision({
      check: "is it green?",
      images: [{ data: png, format: "png", detail: "low" }],
      params: { model: "some-future-chat-model", reasoning: "high" },
      profile,
      network,
    });
    const request = openaiMock.create.mock.calls[0]?.[0];
    expect(request).toMatchObject({ model: "some-future-chat-model", reasoning_effort: "high" });
    expect(request).not.toHaveProperty("reasoning");
    expect(request.messages[1].content[1].image_url.detail).toBe("low");
  });

  it("vision sends a supported model its full parameters", async () => {
    openaiMock.create.mockResolvedValue({
      choices: [{ message: { content: '{"ok":true,"score":1,"reasons":[]}' } }],
    });
    await openaiVision({
      check: "is it green?",
      images: [{ data: png, format: "png", detail: "auto" }],
      params: { model: "gpt-6-luna", reasoning: "none" },
      profile,
      network,
    });
    const request = openaiMock.create.mock.calls[0]?.[0];
    expect(request).toMatchObject({ model: "gpt-6-luna", reasoning_effort: "none" });
    expect(request.messages[1].content[1].image_url.detail).toBe("auto");
    expect(request.response_format.json_schema.strict).toBe(true);
  });

  it("vision sends its built-in prompt beside the strict schema, and a caller's prompt unchanged", async () => {
    openaiMock.create.mockResolvedValue({
      choices: [{ message: { content: '{"ok":true,"score":1,"reasons":[]}' } }],
    });
    // The schema owns the shape; the prompt states only what the schema cannot.
    for (const field of ["ok is true only", "score is your confidence", "reasons lists"]) {
      expect(OPENAI_VISION_SYSTEM_PROMPT).toContain(field);
    }
    expect(OPENAI_VISION_SYSTEM_PROMPT).not.toMatch(/json|only with|nothing else/i);
    for (const [params, expected] of [
      [{}, OPENAI_VISION_SYSTEM_PROMPT],
      [{ systemPrompt: "Answer as a print inspector." }, "Answer as a print inspector."],
    ] as const) {
      openaiMock.create.mockClear();
      await openaiVision({ check: "is it green?", images: [{ data: png, format: "png" }], params, profile, network });
      const request = openaiMock.create.mock.calls[0]?.[0];
      expect(request.messages[0]).toEqual({ role: "system", content: expected });
      expect(request).not.toHaveProperty("systemPrompt");
    }
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
      JSON.stringify({ ok: true, score: 1, reasons: [{}] }), // reasons must be strings
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

// A failed call keeps what it sent in each attempt's log line (data-lifecycle-conventions, *Records*).
describe("OpenAI provider failure records", () => {
  let tmp: string;
  let png: Uint8Array;

  beforeEach(async () => {
    openaiMock.generate.mockReset();
    openaiMock.edit.mockReset();
    openaiMock.create.mockReset();
    openaiMock.toFile.mockClear();
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-provider-records-"));
    png = new Uint8Array(await readFile(path.join(FIXTURES, "green-disk.png")));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function apiError(status: number): Error {
    return Object.assign(new Error(`${status} provider said no`), {
      status,
      headers: { authorization: "Bearer sk-local", "retry-after-ms": "0" },
    });
  }

  // The logger queues file writes; closing it waits for them before a test reads the file.
  let lastLogger: Logger | undefined;
  async function makeLogger(logPath: string, verb: LogVerb): Promise<Logger> {
    lastLogger = await createLogger(logPath, verb);
    return lastLogger;
  }

  async function failingNetwork() {
    const logPath = path.join(tmp, "call.log");
    const logger = await makeLogger(logPath, "generate");
    return { network: { ...network, logger }, logPath };
  }

  async function records(logPath: string): Promise<{ text: string; lines: Array<Record<string, any>> }> {
    await lastLogger?.close();
    const text = await readFile(logPath, "utf-8");
    return { text, lines: text.trimEnd().split("\n").map((line) => JSON.parse(line)) };
  }

  const headers = { Authorization: "Bearer [REDACTED]" };

  it("generate records every attempt's whole request, headers with the key masked, and its status", async () => {
    openaiMock.generate.mockRejectedValueOnce(apiError(429)).mockRejectedValueOnce(apiError(400));
    const { network: net, logPath } = await failingNetwork();

    await expect(
      openaiGenerate({
        prompt: "a green disk",
        params: { model: "gpt-image-2", size: "1024x1024", quality: "low", background: "transparent" },
        profile,
        network: net,
      }),
    ).rejects.toMatchObject({ code: "provider.requestFailed" });

    const { lines } = await records(logPath);
    const request = {
      headers,
      body: {
        model: "gpt-image-2",
        size: "1024x1024",
        quality: "low",
        background: "transparent",
        prompt: "a green disk",
      },
    };
    expect(lines).toEqual([
      expect.objectContaining({
        level: "warn",
        stage: "retry",
        data: expect.objectContaining({
          attempt: 1,
          request,
          status: 429,
          error: expect.objectContaining({ message: "429 provider said no" }),
        }),
      }),
      expect.objectContaining({
        level: "warn",
        stage: "response",
        message: "imageGenerate attempt 2 failed",
        data: expect.objectContaining({ attempt: 2, request, status: 400 }),
      }),
    ]);
  });

  it("records the profile's organization and project headers beside the key", async () => {
    openaiMock.generate.mockRejectedValue(apiError(400));
    const { network: net, logPath } = await failingNetwork();
    await expect(
      openaiGenerate({
        prompt: "p",
        params: { model: "gpt-image-2" },
        profile: { ...profile, redacted: { provider: "openai", organization: "org-1", project: "proj-1" } },
        network: net,
      }),
    ).rejects.toMatchObject({ code: "provider.requestFailed" });
    const { lines } = await records(logPath);
    expect(lines[0]!.data.request.headers).toEqual({
      Authorization: "Bearer [REDACTED]",
      "OpenAI-Organization": "org-1",
      "OpenAI-Project": "proj-1",
    });
  });

  it("records the successful attempt's request, response, usage and duration before any download", async () => {
    const { server, url } = await listen((_req, res) => {
      res.writeHead(403).end("expired");
    });
    const usage = { total_tokens: 7, input_tokens: 3, output_tokens: 4 };
    openaiMock.generate.mockResolvedValue({ created: 1, data: [{ b64_json: pngBase64(png) }, { url }], usage });
    const { network: net, logPath } = await failingNetwork();

    await openaiGenerate({ prompt: "p", params: { model: "gpt-image-2" }, profile, network: net }).finally(
      () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
    );

    const { text, lines } = await records(logPath);
    expect(lines.map((line) => line.message)).toEqual(["imageGenerate attempt 1 succeeded", "imageDownload attempt 1 failed"]);
    expect(lines[0]).toMatchObject({
      level: "info",
      stage: "response",
      data: {
        budget: "imageGenerate",
        attempt: 1,
        durationMs: expect.any(Number),
        outcome: "succeeded",
        request: { headers, body: { model: "gpt-image-2", prompt: "p" } },
        response: {
          status: 200,
          headers: { "x-request-id": "req_test" },
          requestId: "req_test",
          body: { created: 1, data: [{ b64_json: null }, { url }], usage },
        },
      },
    });
    expect(text).not.toContain(pngBase64(png).slice(0, 40));
  });

  it("records a failed download attempt with its URL, query values masked", async () => {
    const { server, url } = await listen((_req, res) => {
      res.writeHead(403).end("expired");
    });
    const signedUrl = `${url}?se=2026-10-05&sig=secret-token`;
    openaiMock.generate.mockResolvedValue({ data: [{ url: signedUrl }] });
    const { network: net, logPath } = await failingNetwork();

    const result = await openaiGenerate({ prompt: "p", params: { model: "gpt-image-2" }, profile, network: net }).finally(
      () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
    );

    expect(result.images[0]).toMatchObject({ data: null });
    const { text, lines } = await records(logPath);
    expect(text).not.toContain("secret-token");
    expect(lines).toEqual([
      expect.objectContaining({
        message: "imageGenerate attempt 1 succeeded",
        data: expect.objectContaining({
          response: expect.objectContaining({ body: { data: [{ url: `${url}?se=[REDACTED]&sig=[REDACTED]` }] } }),
        }),
      }),
      expect.objectContaining({
        stage: "response",
        message: "imageDownload attempt 1 failed",
        data: expect.objectContaining({ request: { url: `${url}?se=[REDACTED]&sig=[REDACTED]` }, status: 403 }),
      }),
    ]);
  });

  it("keeps the provider's own failed response on each failed attempt", async () => {
    const body = { message: "Invalid size", type: "invalid_request_error", param: "size", code: "invalid_value" };
    openaiMock.generate.mockRejectedValue(
      Object.assign(new Error("400 Invalid size"), {
        status: 400,
        headers: new Headers({ "x-request-id": "req_123" }),
        requestID: "req_123",
        error: body,
      }),
    );
    const { network: net, logPath } = await failingNetwork();

    await expect(openaiGenerate({ prompt: "p", params: { model: "gpt-image-2" }, profile, network: net })).rejects.toMatchObject({
      code: "provider.requestFailed",
    });

    const { lines } = await records(logPath);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.data.response).toEqual({ status: 400, headers: { "x-request-id": "req_123" }, requestId: "req_123", body });
  });

  it("generate keeps the built request when the request never left", async () => {
    const refused = Object.assign(new Error("Connection error."), {
      name: "APIConnectionError",
      cause: Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) }),
    });
    openaiMock.generate.mockRejectedValue(refused);
    const { network: net, logPath } = await failingNetwork();

    await expect(
      openaiGenerate({ prompt: "p", params: { model: "gpt-image-2" }, profile, network: net }),
    ).rejects.toMatchObject({ code: "provider.requestFailed" });

    const { lines } = await records(logPath);
    expect(lines).toHaveLength(NETWORK_DEFAULTS.imageGenerate.maxRetries + 1);
    for (const line of lines) {
      expect(line.data).toMatchObject({
        request: { headers, body: { model: "gpt-image-2", prompt: "p" } },
        status: null,
        error: { name: "APIConnectionError", code: "ECONNREFUSED" },
      });
      expect(line.data).not.toHaveProperty("response");
    }
    expect(lines.map((line) => line.data.attempt)).toEqual([1, 2, 3]);
  });

  it("edit records its uploads by file name, which hold their bytes, beside the headers", async () => {
    openaiMock.edit.mockRejectedValue(apiError(400));
    const { network: net, logPath } = await failingNetwork();

    await expect(
      openaiEdit({
        prompt: "edit it",
        imagePath: path.join(FIXTURES, "green-disk.png"),
        maskPath: path.join(FIXTURES, "donut.png"),
        params: { model: "gpt-image-2", quality: "low" },
        profile,
        network: net,
      }),
    ).rejects.toMatchObject({ code: "provider.requestFailed" });

    const { lines } = await records(logPath);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.data.request).toEqual({
      headers,
      body: {
        model: "gpt-image-2",
        quality: "low",
        prompt: "edit it",
        image: "green-disk.png",
        mask: "donut.png",
      },
    });
  });

  it("vision records its whole request but each image's data URL, which the input file holds", async () => {
    openaiMock.create.mockRejectedValue(apiError(400));
    const { network: net, logPath } = await failingNetwork();

    await expect(
      openaiVision({
        check: "is it green?",
        images: [{ data: png, format: "png", detail: "high" }],
        params: { model: "gpt-6-luna" },
        profile,
        network: net,
      }),
    ).rejects.toMatchObject({ code: "provider.requestFailed" });

    const { text, lines } = await records(logPath);
    expect(lines).toHaveLength(1);
    const { headers: recordedHeaders, body } = lines[0]!.data.request;
    expect(recordedHeaders).toEqual(headers);
    expect(body).toMatchObject({ model: "gpt-6-luna", response_format: { type: "json_schema" } });
    expect(body.messages[1].content).toEqual([
      { type: "text", text: "is it green?" },
      { type: "image_url", image_url: { url: null, detail: "high" } },
    ]);
    expect(text).not.toContain("base64");
    // The call itself still sent the bytes.
    expect(openaiMock.create.mock.calls[0]?.[0].messages[1].content[1].image_url.url).toMatch(
      /^data:image\/png;base64,/,
    );
  });

  it("vision records an id with no row's caller-set detail and effort in the attempt's request", async () => {
    openaiMock.create.mockRejectedValueOnce(apiError(400));
    const logPath = path.join(tmp, "vision-unlisted.log");
    const logger = await makeLogger(logPath, "vision");
    await expect(
      openaiVision({
        check: "is it green?",
        images: [{ data: png, format: "png", detail: "low" }],
        params: { model: "some-future-chat-model", reasoning: "high" },
        profile,
        network: { ...network, logger },
      }),
    ).rejects.toMatchObject({ code: "provider.requestFailed" });

    const { lines } = await records(logPath);
    expect(lines).toHaveLength(1);
    const body = lines[0]!.data.request.body;
    expect(body).toMatchObject({ model: "some-future-chat-model", reasoning_effort: "high" });
    expect(body.messages[1].content[1]).toEqual({ type: "image_url", image_url: { url: null, detail: "low" } });
  });

  it("vision records the request and the response when the answer yields no verdict", async () => {
    const answers = [
      { choices: [{ message: { content: null, refusal: "I cannot judge this." } }] },
      { choices: [{ finish_reason: "content_filter", message: { content: null } }] },
      { choices: [{ finish_reason: "stop", message: { content: "not json" } }] },
    ];
    for (const [i, answer] of answers.entries()) {
      openaiMock.create.mockResolvedValueOnce(answer);
      const logPath = path.join(tmp, `vision-${i}.log`);
      const logger = await makeLogger(logPath, "vision");
      await expect(
        openaiVision({
          check: "is it green?",
          images: [{ data: png, format: "png" }],
          params: { model: "gpt-6-luna" },
          profile,
          network: { ...network, logger },
        }),
      ).rejects.toMatchObject({ errorType: "provider" });

      const { text, lines } = await records(logPath);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({ stage: "response", data: { outcome: "succeeded", response: { body: answer } } });
      expect(lines[1]).toMatchObject({ level: "warn", stage: "response", data: { response: answer } });
      expect(lines[1]!.data.request.headers).toEqual(headers);
      expect(lines[1]!.data.request.body.messages[1].content[1]).toEqual({ type: "image_url", image_url: { url: null } });
      expect(lines[1]!.data.error.code).toMatch(/^provider\./);
      expect(text).not.toContain("base64");
    }
  });

  it("generate records a cancelled attempt with its request", async () => {
    const ctrl = new AbortController();
    openaiMock.generate.mockImplementation(async () => {
      ctrl.abort(new Error("stop"));
      throw Object.assign(new Error("Request was aborted."), { name: "AbortError" });
    });
    const { network: net, logPath } = await failingNetwork();

    await expect(
      openaiGenerate({
        prompt: "a green disk",
        params: { model: "gpt-image-2", quality: "low" },
        profile,
        network: { ...net, signal: ctrl.signal },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    const { lines } = await records(logPath);
    expect(lines).toEqual([
      expect.objectContaining({
        stage: "cancelled",
        data: expect.objectContaining({
          attempt: 1,
          request: { headers, body: { model: "gpt-image-2", quality: "low", prompt: "a green disk" } },
          outcome: "cancelled",
        }),
      }),
    ]);
  });
});
