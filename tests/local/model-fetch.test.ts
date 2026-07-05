import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultModelsDir } from "../../src/internal/paths.js";
import { ensureModel, stagingPathFor } from "../../src/local/models/fetch.js";
import type { ModelEntry } from "../../src/local/models/registry.js";
import type { Logger } from "../../src/log/index.js";

function listen(handler: http.RequestListener): Promise<{
  server: http.Server;
  baseURL: string;
}> {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, baseURL: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

const stderrWriteOriginal = process.stderr.write.bind(process.stderr);

function silenceStderr(): void {
  process.stderr.write = ((_chunk: unknown, cb?: () => void): boolean => {
    cb?.();
    return true;
  }) as typeof process.stderr.write;
}

function restoreStderr(): void {
  process.stderr.write = stderrWriteOriginal;
}

describe("defaultModelsDir", () => {
  it("returns <profileDir>/models by default", () => {
    const prev = process.env.GPTIMG_MODELS_DIR;
    delete process.env.GPTIMG_MODELS_DIR;
    try {
      expect(defaultModelsDir("/some/dir")).toBe("/some/dir/models");
    } finally {
      if (prev !== undefined) process.env.GPTIMG_MODELS_DIR = prev;
    }
  });

  it("honors GPTIMG_MODELS_DIR when set", () => {
    const prev = process.env.GPTIMG_MODELS_DIR;
    process.env.GPTIMG_MODELS_DIR = "/elsewhere/models";
    try {
      expect(defaultModelsDir("/some/dir")).toBe("/elsewhere/models");
    } finally {
      if (prev === undefined) delete process.env.GPTIMG_MODELS_DIR;
      else process.env.GPTIMG_MODELS_DIR = prev;
    }
  });
});

describe("stagingPathFor", () => {
  it("names the staged file <stem>-<pid>-<random>.tmp inside temp/, derived from the model's stem", () => {
    const p = stagingPathFor("/cache", "birefnet-general-fp16-v1.onnx");
    expect(path.dirname(p)).toBe(path.join("/cache", "temp"));
    expect(path.basename(p)).toMatch(
      new RegExp(`^birefnet-general-fp16-v1-${process.pid}-[A-Za-z0-9_-]{21}\\.tmp$`),
    );
  });
});

describe("ensureModel", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-model-fetch-"));
    silenceStderr();
  });

  afterEach(async () => {
    restoreStderr();
    await rm(tmp, { recursive: true, force: true });
  });

  it("reports download progress through the logger, never to stderr", async () => {
    const body = Buffer.from(new Uint8Array(64));
    const { server, baseURL } = await listen((_req, res) => {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(body.length),
      });
      res.end(body);
    });
    const events: { stage: string; msg: string }[] = [];
    const logger: Logger = {
      handle: { path: path.join(tmp, "dl.jsonl"), verb: "model" },
      info: async (stage, msg) => {
        events.push({ stage, msg });
      },
      warn: async () => {},
      error: async () => {},
      debug: async () => {},
      close: async () => {},
    };
    // Spy stderr for the duration of the download; the SDK must not touch it.
    const stderrSpy = vi.fn(() => true);
    process.stderr.write = stderrSpy as unknown as typeof process.stderr.write;
    try {
      const entry: ModelEntry = { name: "prog.bin", url: baseURL, inputSize: 0 };
      await ensureModel(entry, tmp, { logger });
    } finally {
      await closeServer(server);
    }
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(events.every((e) => e.stage === "download")).toBe(true);
    expect(events.some((e) => e.msg.startsWith("downloading prog.bin"))).toBe(true);
    expect(events.some((e) => e.msg.startsWith("downloaded prog.bin"))).toBe(true);
  });

  it("stages the download in temp/ and atomically publishes to the final name", async () => {
    const body = Buffer.from(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    const { server, baseURL } = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(body);
    });
    try {
      const entry: ModelEntry = {
        name: "test.bin",
        url: baseURL,
        inputSize: 0,
      };
      const finalPath = await ensureModel(entry, tmp);
      expect(finalPath).toBe(path.join(tmp, "test.bin"));
      // Staged in the dedicated temp/ dir (not beside the kept model), and the
      // staged copy — named `<stem>-<pid>-<random>.tmp` — is removed after the
      // atomic publish.
      expect(existsSync(path.join(tmp, "temp"))).toBe(true);
      expect(await readdir(path.join(tmp, "temp"))).toEqual([]);
      const got = await readFile(finalPath);
      expect(Array.from(new Uint8Array(got))).toEqual(Array.from(new Uint8Array(body)));
    } finally {
      await closeServer(server);
    }
  });

  it("refuses a non-https remote URL before any byte is fetched", async () => {
    const entry: ModelEntry = {
      name: "insecure.bin",
      url: "http://example.com/model.bin",
      inputSize: 0,
    };
    await expect(ensureModel(entry, tmp)).rejects.toMatchObject({
      code: "model.insecureUrl",
    });
    expect(existsSync(path.join(tmp, entry.name))).toBe(false);
  });

  it("skips the download when the cached file already exists", async () => {
    const fetcher = vi.fn();
    const { server, baseURL } = await listen(((_req: http.IncomingMessage, res: http.ServerResponse) => {
      fetcher();
      res.writeHead(500);
      res.end();
    }) as http.RequestListener);
    try {
      const entry: ModelEntry = {
        name: "cached.bin",
        url: baseURL,
        inputSize: 0,
      };
      await writeFile(path.join(tmp, entry.name), Buffer.from([5, 5, 5, 5]));
      const finalPath = await ensureModel(entry, tmp);
      expect(finalPath).toBe(path.join(tmp, "cached.bin"));
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it("removes the staged .tmp file when the download itself fails", async () => {
    const { server, baseURL } = await listen((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    try {
      const entry: ModelEntry = {
        name: "missing.bin",
        url: baseURL,
        inputSize: 0,
      };
      await expect(ensureModel(entry, tmp)).rejects.toMatchObject({
        code: "model.downloadFailed",
      });
      expect(existsSync(path.join(tmp, entry.name))).toBe(false);
      // The staged copy in temp/ is cleaned up on failure, not left behind.
      expect(await readdir(path.join(tmp, "temp"))).toEqual([]);
    } finally {
      await closeServer(server);
    }
  });

  it("rejects a sha256 mismatch and does not publish", async () => {
    const body = Buffer.from(new Uint8Array([9, 8, 7, 6]));
    const { server, baseURL } = await listen((_req, res) => {
      res.writeHead(200);
      res.end(body);
    });
    try {
      const entry: ModelEntry = {
        name: "verify-bad.bin",
        url: baseURL,
        inputSize: 0,
        sha256: "0000000000000000000000000000000000000000000000000000000000000000",
      };
      await expect(ensureModel(entry, tmp)).rejects.toMatchObject({
        code: "model.checksumMismatch",
      });
      expect(existsSync(path.join(tmp, entry.name))).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it("accepts a matching sha256", async () => {
    const body = Buffer.from(new Uint8Array([1, 1, 2, 3, 5, 8]));
    const sha = createHash("sha256").update(body).digest("hex");
    const { server, baseURL } = await listen((_req, res) => {
      res.writeHead(200);
      res.end(body);
    });
    try {
      const entry: ModelEntry = { name: "verify-ok.bin", url: baseURL, inputSize: 0, sha256: sha };
      const finalPath = await ensureModel(entry, tmp);
      expect(existsSync(finalPath)).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it("force re-downloads and replaces the cached file", async () => {
    let hits = 0;
    const { server, baseURL } = await listen((_req, res) => {
      hits += 1;
      res.writeHead(200);
      res.end(Buffer.from(hits === 1 ? "AAAA" : "BBBB"));
    });
    try {
      const entry: ModelEntry = { name: "force.bin", url: baseURL, inputSize: 0 };
      const p1 = await ensureModel(entry, tmp);
      expect((await readFile(p1)).toString()).toBe("AAAA");
      await ensureModel(entry, tmp); // cached: no new fetch
      expect(hits).toBe(1);
      const p2 = await ensureModel(entry, tmp, { force: true });
      expect((await readFile(p2)).toString()).toBe("BBBB");
      expect(hits).toBe(2);
    } finally {
      await closeServer(server);
    }
  });
});
