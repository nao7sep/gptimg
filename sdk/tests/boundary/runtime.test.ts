// The runtime side of the package boundary: with a throwaway HOME and every
// ambient variable gptimg or the OpenAI client could read set, a local verb, a
// paid verb against a local HTTP provider and the model listing write nothing
// outside the locations they are given, send no ambient key, organization,
// project or base URL, and print nothing. OPENAI_CUSTOM_HEADERS is the one read
// the OpenAI client offers no switch for; it is left unset here, as recorded
// beside the client's construction.
import http from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GptImg } from "../../src/index.ts";
import { done } from "../helpers/results.ts";
import { captureStderr } from "../helpers/streams.ts";

const local = vi.hoisted(() => ({ baseURL: "" }));
vi.mock("../../src/providers/openai/client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/providers/openai/client.ts")>();
  return {
    ...actual,
    buildOpenAIClient: (credentials: Parameters<typeof actual.buildOpenAIClient>[0]) => {
      const client = actual.buildOpenAIClient(credentials);
      // The SDK pins the default endpoint; the test redirects only the transport.
      expect(client.baseURL).toBe("https://api.openai.com/v1");
      client.baseURL = local.baseURL;
      return client;
    },
  };
});

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "green-disk.png");

describe("the runtime boundary", () => {
  let tmp: string;
  let home: string;
  let server: http.Server;
  const requests: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-boundary-"));
    home = path.join(tmp, "home");
    await mkdir(home);
    requests.length = 0;
    const png = (await sharp(FIXTURE).png().toBuffer()).toString("base64");
    server = http.createServer((req, res) => {
      requests.push({ url: req.url ?? "", headers: req.headers });
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json", "x-request-id": "req-boundary" });
        res.end(JSON.stringify({ created: 1, data: [{ b64_json: png }], usage: { total_tokens: 1 } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    local.baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("OPENAI_API_KEY", "sk-ambient-must-not-be-used");
    vi.stubEnv("OPENAI_ORG_ID", "org-ambient");
    vi.stubEnv("OPENAI_PROJECT_ID", "proj-ambient");
    vi.stubEnv("OPENAI_BASE_URL", "https://ambient.invalid/v1");
    vi.stubEnv("OPENAI_ADMIN_KEY", "sk-admin-ambient");
    vi.stubEnv("OPENAI_LOG", "debug");
    vi.stubEnv("GPTIMG_DATA_DIR", path.join(tmp, "ambient-data"));
    vi.stubEnv("GPTIMG_MODELS_DIR", path.join(tmp, "ambient-models"));
    vi.stubEnv("GPTIMG_DEBUG", "1");
    vi.stubEnv("GPTIMG_ONNX_EP", "coreml");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tmp, { recursive: true, force: true });
  });

  it("writes only where it is told, sends no ambient value, and prints nothing", async () => {
    const out = path.join(tmp, "out");
    const stdout = vi.spyOn(process.stdout, "write");
    const stderr = await captureStderr(async () => {
      const img = new GptImg({ apiKey: "sk-explicit" });
      const resized = done(await img.resize({ in: FIXTURE, toSize: 32, outDir: out, outName: "small" }));
      expect(resized).not.toHaveProperty("logPath");
      const generated = done(await img.generate({ prompt: "a disc", outDir: out, outName: "paid" }));
      expect(generated.files).toHaveLength(1);
      const listed = img.model.list();
      expect(listed.models.every((m) => m.path.startsWith(path.join(home, ".gptimgsdk", "models")))).toBe(true);
    });
    expect(stderr.join("")).toBe("");
    expect(stdout).not.toHaveBeenCalled();
    stdout.mockRestore();

    // Only the given output folder was written; nothing appeared under HOME or the ambient folders.
    expect(readdirSync(out).sort()).toEqual(["paid.json", "paid.png", "small.png"]);
    expect(readdirSync(home)).toEqual([]);
    expect(existsSync(path.join(tmp, "ambient-data"))).toBe(false);
    expect(existsSync(path.join(tmp, "ambient-models"))).toBe(false);

    // The one request carried the explicit key and no ambient identity.
    expect(requests).toHaveLength(1);
    const headers = requests[0]!.headers;
    expect(headers.authorization).toBe("Bearer sk-explicit");
    expect(headers["openai-organization"]).toBeUndefined();
    expect(headers["openai-project"]).toBeUndefined();
  });

  it("refuses a paid call without a given key even when OPENAI_API_KEY is set", async () => {
    await expect(new GptImg().generate({ prompt: "x", outDir: path.join(tmp, "out") })).rejects.toMatchObject({
      code: "apiKey.missing",
    });
    expect(requests).toHaveLength(0);
  });
});
