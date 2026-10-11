import http from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GptImg } from "../../src/index.js";
import type { LogEntry } from "../../src/types.js";

// End to end against a local stand-in for the OpenAI API, with a fake key: the
// key must reach the server and no sink — log file, progress event, thrown
// error or sidecar.
const FAKE = "sk-test-FAKE-0123456789abcdef";
const SIG = "TOKEN-FAKE-xyz";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PNG_B64 = (await readFile(path.resolve(HERE, "..", "fixtures", "green-disk.png"))).toString("base64");

type Mode = "echo401" | "success" | "signedUrl" | "shortQuery" | "hang";

describe("credential masking across every sink", () => {
  let tmp: string;
  let server: http.Server;
  let mode: Mode;
  let receivedAuth: string[];
  let sdk: GptImg;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-masking-"));
    receivedAuth = [];
    server = http.createServer((req, res) => {
      if (req.url?.startsWith("/v1/images/generations")) {
        receivedAuth.push(req.headers.authorization ?? "");
        const { port } = server.address() as { port: number };
        if (mode === "echo401") {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${FAKE}.`, code: "invalid_api_key" } }));
        } else if (mode === "success") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ created: 1, data: [{ b64_json: PNG_B64 }] }));
        } else if (mode === "signedUrl" || mode === "shortQuery") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ created: 1, data: [{ url: `http://127.0.0.1:${port}/img.png?sig=${SIG}&v=1&flag=true` }] }));
        }
        // "hang": never answer; the caller cancels.
        return;
      }
      if (req.url?.startsWith("/img.png")) {
        if (mode === "shortQuery") res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from(PNG_B64, "base64"));
        else res.writeHead(403).end(`denied ${req.url}`);
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as { port: number };
    vi.stubEnv("OPENAI_BASE_URL", `http://127.0.0.1:${port}/v1`);
    vi.stubEnv("GPTIMG_TEST_FAKE_KEY", FAKE);
    await mkdir(path.join(tmp, "data"));
    await writeFile(
      path.join(tmp, "data", "profile.json"),
      JSON.stringify({ formatVersion: 1, provider: "openai", apiKeyEnv: "GPTIMG_TEST_FAKE_KEY" }),
      { mode: 0o600 },
    );
    sdk = new GptImg({ profileDir: path.join(tmp, "data"), logDir: path.join(tmp, "logs") });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tmp, { recursive: true, force: true });
  });

  async function run(m: Mode, signal?: AbortSignal): Promise<{ events: string; thrown: string }> {
    mode = m;
    const events: LogEntry[] = [];
    let thrown = "";
    try {
      await sdk.generate(
        { prompt: "a green disk", outDir: path.join(tmp, "out"), outName: m },
        { onProgress: (e) => events.push(e), ...(signal && { signal }) },
      );
    } catch (err) {
      const e = err as Error;
      thrown = `${e.message}\n${e.stack ?? ""}`;
    }
    return { events: JSON.stringify(events), thrown };
  }

  async function logs(): Promise<string> {
    const dir = path.join(tmp, "logs");
    const files = await readdir(dir);
    if (process.platform !== "win32") {
      for (const f of files) expect((await stat(path.join(dir, f))).mode & 0o777).toBe(0o600);
    }
    return (await Promise.all(files.map((f) => readFile(path.join(dir, f), "utf-8")))).join("\n");
  }

  it("masks an echoed key in records, events and the thrown error, while the server receives it", async () => {
    const { events, thrown } = await run("echo401");
    expect(thrown).toContain("[REDACTED]");
    expect(thrown).not.toContain(FAKE);
    expect(events).not.toContain(FAKE);
    const text = await logs();
    expect(text).not.toContain(FAKE);
    expect(text).toContain("Bearer [REDACTED]");
    expect(receivedAuth).toEqual([`Bearer ${FAKE}`]);
  });

  it("masks the key in a successful call's records and keeps it out of the sidecar", async () => {
    const { events, thrown } = await run("success");
    expect(thrown).toBe("");
    expect(events).toContain("Bearer [REDACTED]");
    expect(events).not.toContain(FAKE);
    expect(await logs()).not.toContain(FAKE);
    expect(await readFile(path.join(tmp, "out", "success.json"), "utf-8")).not.toContain(FAKE);
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
    expect(await readFile(path.join(tmp, "out", "shortQuery.png"))).toEqual(Buffer.from(PNG_B64, "base64"));
    const text = await logs();
    const entries = text.trim().split("\n").map((line) => JSON.parse(line) as LogEntry);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((entry) => entry.data?.itemCount === 1)).toBe(true);
    expect(JSON.parse(events)).toEqual(expect.any(Array));
    expect(text).not.toContain(SIG);
    expect(events).not.toContain(SIG);
    expect(text).toContain("v=[REDACTED]&flag=[REDACTED]");
  });

  it("masks the key in the records of a cancelled call", async () => {
    const ctrl = new AbortController();
    const pending = run("hang", ctrl.signal);
    await vi.waitFor(() => expect(receivedAuth).toHaveLength(1));
    ctrl.abort();
    const { events, thrown } = await pending;
    expect(thrown).not.toBe("");
    expect(events).not.toContain(FAKE);
    expect(await logs()).not.toContain(FAKE);
  });
});
