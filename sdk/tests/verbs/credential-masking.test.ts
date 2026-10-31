import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APIConnectionTimeoutError, APIError, AuthenticationError } from "openai";
import { GptImg } from "../../src/index.ts";

// The SDK builds its OpenAI client with an explicit base URL and ignores the
// process environment, so these tests point the real client at the local
// server through the client builder instead of OPENAI_BASE_URL.
const local = vi.hoisted(() => ({ baseURL: "" }));
vi.mock("../../src/providers/openai/client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/providers/openai/client.ts")>();
  return {
    ...actual,
    buildOpenAIClient: (credentials: Parameters<typeof actual.buildOpenAIClient>[0]) => {
      const client = actual.buildOpenAIClient(credentials);
      client.baseURL = local.baseURL;
      return client;
    },
  };
});
import { GptImgError } from "../../src/errors.ts";
import { NETWORK_DEFAULTS } from "../../src/network/index.ts";
import type { EditResult, GenerateResult, SdkEvent, VisionResult } from "../../src/types.ts";
import type { RefusedResult } from "../../src/refusal.ts";

// End to end against a local stand-in for the OpenAI API, with a fake key: the
// key must reach the server and no sink — progress event, thrown
// error or sidecar.
const FAKE = "sk-test-FAKE-0123456789abcdef";
const SIG = "TOKEN-FAKE-xyz";
const ENCODED_SIG = "a%2Fb%2Bc%3Dd";
const DECODED_SIG = "a/b+c=d";
const PLUS_SIG = "signed+value%2Btail";
const DECODED_PLUS_SIG = "signed value+tail";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const INPUT = path.resolve(HERE, "..", "fixtures", "green-disk.png");
const PNG_B64 = (await readFile(INPUT)).toString("base64");

type Mode = "echo401" | "success" | "refusal" | "signedUrl" | "shortQuery" | "encodedUrl" | "plusUrl" | "hang" | "timeout";
type Verb = "generate" | "edit" | "vision";

// Include nonenumerable Error.message/stack/cause and structured SDK fields;
// JSON.stringify(error) alone silently misses the most useful error evidence.
function diagnosticStrings(value: unknown, seen = new Set<object>()): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  if (value instanceof Headers) return [...value.values()];
  return Reflect.ownKeys(value).flatMap((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor ? diagnosticStrings("value" in descriptor ? descriptor.value : Reflect.get(value, key), seen) : [];
  });
}

describe("credential masking across every sink", () => {
  let tmp: string;
  let server: http.Server;
  let mode: Mode;
  let receivedAuth: string[];
  let requestArrived: () => void;
  let receivedBodies: string[];
  let sdk: GptImg;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-masking-"));
    receivedAuth = [];
    requestArrived = () => {};
    receivedBodies = [];
    server = http.createServer(async (req, res) => {
      if (req.url?.startsWith("/v1/")) {
        receivedAuth.push(req.headers.authorization ?? "");
        let body = "";
        for await (const chunk of req) body += chunk.toString();
        receivedBodies.push(body);
        const { port } = server.address() as { port: number };
        requestArrived();
        if (mode === "echo401") {
          res.writeHead(401, { "content-type": "application/json", "x-request-id": "request-fake", "x-provider-echo": FAKE });
          res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${FAKE}.`, code: "invalid_api_key", type: "invalid_request_error", details: { credential: FAKE } } }));
        } else if (mode === "success") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(req.url?.startsWith("/v1/chat/")
            ? { choices: [{ message: { content: JSON.stringify({ ok: true, score: 1, reasons: [`echo ${FAKE}`] }) } }], echo: { credential: FAKE } }
            : { created: 1, data: [{ b64_json: PNG_B64, revised_prompt: `echo ${FAKE}` }], echo: { credential: FAKE } }));
        } else if (mode === "refusal") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: null, refusal: `Cannot verify with credential ${FAKE}.` } }] }));
        } else if (mode === "signedUrl" || mode === "shortQuery" || mode === "encodedUrl" || mode === "plusUrl") {
          const sig = mode === "encodedUrl" ? ENCODED_SIG : mode === "plusUrl" ? PLUS_SIG : SIG;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ created: 1, data: [{ url: `http://127.0.0.1:${port}/img.png?sig=${sig}&v=1&flag=true` }] }));
        }
        // "hang" and "timeout": never answer; cancellation or the SDK budget settles the call.
        return;
      }
      if (req.url?.startsWith("/img.png")) {
        if (mode === "shortQuery") res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from(PNG_B64, "base64"));
        else res.writeHead(403).end(`denied ${req.url}; decoded ${new URL(req.url, "http://localhost").searchParams.get("sig")}`);
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as { port: number };
    local.baseURL = `http://127.0.0.1:${port}/v1`;
    sdk = new GptImg({ apiKey: FAKE });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tmp, { recursive: true, force: true });
  });

  async function run(m: Mode, signal?: AbortSignal, verb: Verb = "generate", instruction = "a green disk"): Promise<{
    events: string;
    thrown: string;
    error: unknown;
    result: GenerateResult | EditResult | VisionResult | undefined;
    refused: RefusedResult | undefined;
  }> {
    mode = m;
    const events: SdkEvent[] = [];
    let thrown = "";
    let error: unknown;
    let result: GenerateResult | EditResult | VisionResult | undefined;
    let refused: RefusedResult | undefined;
    try {
      const output = { outDir: path.join(tmp, "out"), outName: `${m}-${verb}` };
      const options = { onEvent: (e: SdkEvent) => events.push(e), ...(signal && { signal }) };
      const policy = m === "timeout"
        ? { network: { imageGenerate: { maxRetries: 0 }, imageVision: { maxRetries: 0 } } }
        : undefined;
      const outcome = verb === "vision"
        ? await sdk.vision({ check: instruction, inputs: [INPUT], ...output, policy }, options)
        : verb === "edit"
          ? await sdk.edit({ prompt: instruction, in: INPUT, ...output, policy }, options)
          : await sdk.generate({ prompt: instruction, ...output, policy }, options);
      if (outcome.status === "refused") refused = outcome;
      else result = outcome;
    } catch (err) {
      error = err;
      thrown = diagnosticStrings(err).join("\n");
    }
    lastEvents = events;
    return { events: JSON.stringify(events), thrown, error, result, refused };
  }

  // The SDK writes no log; its events are its record of a call, the one place a credential could leak to.
  let lastEvents: SdkEvent[] = [];
  async function logs(): Promise<string> {
    return JSON.stringify(lastEvents);
  }


  it.each<Verb>(["generate", "edit", "vision"])("masks an echoed key throughout %s's real SDK error, preserving its diagnostics", async (verb) => {
    const { events, thrown, error } = await run("echo401", undefined, verb);
    const cause = (error as Error).cause as APIError;
    expect(cause).toBeInstanceOf(APIError);
    expect(cause).toBeInstanceOf(AuthenticationError);
    expect(cause.status).toBe(401);
    expect(cause.code).toBe("invalid_api_key");
    expect(cause.requestID).toBe("request-fake");
    expect(cause.headers).toBeInstanceOf(Headers);
    expect(cause.headers?.get("x-request-id")).toBe("request-fake");
    expect(cause.headers?.get("x-provider-echo")).toBe("[REDACTED]");
    expect(cause.error).toMatchObject({ code: "invalid_api_key", type: "invalid_request_error", details: { credential: "[REDACTED]" } });
    expect(thrown).toContain("[REDACTED]");
    expect(thrown).not.toContain(FAKE);
    expect(events).not.toContain(FAKE);
    const text = await logs();
    expect(text).not.toContain(FAKE);
    expect(text).toContain("Bearer [REDACTED]");
    expect(receivedAuth).toEqual([`Bearer ${FAKE}`]);
  });

  it.each<Verb>(["generate", "edit", "vision"])("masks %s's successful response and request sidecar copies, preserving live content", async (verb) => {
    const { events, thrown, result } = await run("success", undefined, verb, `instruction ${FAKE}`);
    expect(thrown).toBe("");
    expect(events).toContain("Bearer [REDACTED]");
    expect(events).not.toContain(FAKE);
    expect(await logs()).not.toContain(FAKE);
    const sidecarText = await readFile(path.join(tmp, "out", `success-${verb}.json`), "utf-8");
    expect(sidecarText).not.toContain(FAKE);
    const sidecar = JSON.parse(sidecarText);
    expect(sidecar.request[verb === "vision" ? "check" : "prompt"]).toBe("instruction [REDACTED]");
    expect(sidecar.response[verb === "vision" ? "raw" : "echo"]).toBeDefined();
    if (verb === "vision") {
      expect(sidecar.response.verdict.reasons).toEqual(["echo [REDACTED]"]);
      expect((result as VisionResult).reasons).toEqual([`echo ${FAKE}`]);
      // The provider's raw reply in the result is the record's masked copy, as generate's response is.
      expect((result as VisionResult).raw).toMatchObject({ echo: { credential: "[REDACTED]" } });
      expect(JSON.stringify((result as VisionResult).raw)).not.toContain(FAKE);
    } else {
      expect(sidecar.response.data[0].revised_prompt).toBe("echo [REDACTED]");
      expect(sidecar.response.data[0].b64_json).toBeNull();
      expect(sidecar.response.echo.credential).toBe("[REDACTED]");
    }
    expect(receivedBodies[0]).toContain(FAKE);
    expect(receivedAuth).toEqual([`Bearer ${FAKE}`]);
  });

  it("masks an echoed key in a public vision refusal while preserving its safe reason", async () => {
    const { events, thrown, error, refused } = await run("refusal", undefined, "vision");
    expect(error).toBeUndefined();
    expect(refused).toMatchObject({
      status: "refused",
      refusal: { code: "provider.refused", safeReason: "Cannot verify with credential [REDACTED]." },
    });
    expect(JSON.stringify(refused)).not.toContain(FAKE);
    for (const sink of [events, await logs()]) {
      expect(sink).not.toContain(FAKE);
      expect(sink).toContain("[REDACTED]");
    }
    expect(thrown).toBe("");
    expect(receivedAuth).toEqual([`Bearer ${FAKE}`]);
  });

  it.each<Verb>(["generate", "edit", "vision"])("preserves %s's real SDK timeout and native fetch abort diagnostics", async (verb) => {
    // The product's own request deadline, reached on a fake clock once the request is held.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled: Awaited<ReturnType<typeof run>>;
    try {
      const arrived = new Promise<void>((resolve) => { requestArrived = resolve; });
      const running = run("timeout", undefined, verb);
      await arrived;
      await vi.advanceTimersByTimeAsync(verb === "vision" ? NETWORK_DEFAULTS.imageVision.timeout : NETWORK_DEFAULTS.imageGenerate.timeout);
      settled = await running;
    } finally {
      vi.useRealTimers();
    }
    const { events, thrown, error, result } = settled;
    expect(error).toBeInstanceOf(GptImgError);
    expect(error).toMatchObject({ code: "provider.timeout", kind: "unavailable", effect: "unknown" });
    const sdkError = (error as Error).cause as APIConnectionTimeoutError;
    expect(sdkError).toBeInstanceOf(APIConnectionTimeoutError);
    expect(sdkError.message).toBe("Request timed out.");
    const fetchError = sdkError.cause as DOMException;
    expect(fetchError).toBeInstanceOf(DOMException);
    expect(fetchError.name).toBe("AbortError");
    expect(fetchError.message).toBe("This operation was aborted");
    expect(fetchError.code).toBe(DOMException.ABORT_ERR);
    expect(fetchError.stack).toContain("AbortError");
    expect(String(fetchError)).toBe("AbortError: This operation was aborted");
    expect(result).toBeUndefined();
    const text = await logs();
    expect(text).toContain("Request timed out.");
    expect(text).toContain("This operation was aborted");
    for (const sink of [events, thrown, text]) expect(sink).not.toContain(FAKE);
    expect(receivedAuth).toEqual([`Bearer ${FAKE}`]);
  });

  it.each([
    ["encodedUrl", ENCODED_SIG, DECODED_SIG],
    ["plusUrl", PLUS_SIG, DECODED_PLUS_SIG],
  ] as const)("masks both raw and decoded signed URL echoes for %s", async (m, raw, decoded) => {
    const { events, thrown } = await run(m);
    const text = await logs();
    for (const sink of [events, thrown, text]) {
      expect(sink).not.toContain(raw);
      expect(sink).not.toContain(decoded);
    }
    expect(events).toContain("decoded [REDACTED]");
    expect(text).toContain("sig=[REDACTED]");
  });

  it("masks a signed image URL's query in records and events", async () => {
    const { events } = await run("signedUrl");
    expect(events).not.toContain(SIG);
    const text = await logs();
    expect(text).not.toContain(SIG);
    expect(text).toContain("sig=[REDACTED]");
  });

  it("publishes a downloaded image when short query credentials overlap numeric log values", async () => {
    const { events, thrown } = await run("shortQuery");
    expect(thrown).toBe("");
    expect(await readFile(path.join(tmp, "out", "shortQuery-generate.png"))).toEqual(Buffer.from(PNG_B64, "base64"));
    const text = await logs();
    expect(lastEvents.some((entry) => entry.event === "provider.returned" && entry.summary.images === 1)).toBe(true);
    expect(JSON.parse(events)).toEqual(expect.any(Array));
    expect(text).not.toContain(SIG);
    expect(events).not.toContain(SIG);
    expect(text).toContain("v=[REDACTED]&flag=[REDACTED]");
  });

  it("masks the key in the records of a cancelled call", async () => {
    const ctrl = new AbortController();
    const arrived = new Promise<void>((resolve) => { requestArrived = resolve; });
    const pending = run("hang", ctrl.signal);
    await arrived;
    ctrl.abort();
    const { events, thrown } = await pending;
    expect(thrown).not.toBe("");
    expect(events).not.toContain(FAKE);
    expect(await logs()).not.toContain(FAKE);
  });
});
