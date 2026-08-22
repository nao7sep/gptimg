import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultModelsDir } from "../../src/internal/paths.js";
import {
  ensureModel,
  fileSha256,
  modelWholeTimeoutMs,
  stagingPathFor,
} from "../../src/local/models/fetch.js";
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
      const profileDir = path.resolve("some", "dir");
      expect(defaultModelsDir(profileDir)).toBe(path.join(profileDir, "models"));
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

describe("modelWholeTimeoutMs", () => {
  it("is finite and scales with artifact size and possible attempts", () => {
    const small = modelWholeTimeoutMs(1024, 0);
    const large = modelWholeTimeoutMs(489_666_272, 0);
    const retried = modelWholeTimeoutMs(489_666_272, 2);
    expect(Number.isSafeInteger(small)).toBe(true);
    expect(large).toBeGreaterThan(small);
    expect(retried).toBeGreaterThan(large);
  });
});

describe("fileSha256", () => {
  it("stops an in-progress hash when its signal aborts", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "gptimg-model-hash-"));
    const file = path.join(tmp, "model.bin");
    await writeFile(file, Buffer.alloc(1024 * 1024, 7));
    const ctrl = new AbortController();
    try {
      const hashing = fileSha256(file, ctrl.signal);
      queueMicrotask(() => ctrl.abort(new Error("stop")));
      await expect(hashing).rejects.toMatchObject({ code: "cancelled" });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("ensureModel", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-model-fetch-"));
    silenceStderr();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
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

  it("refuses an https redirect to an insecure effective URL", async () => {
    const fetcher = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://example.com/model.bin" },
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const entry: ModelEntry = {
      name: "redirected-insecure.bin",
      url: "https://example.com/model.bin",
      inputSize: 0,
    };

    await expect(ensureModel(entry, tmp)).rejects.toMatchObject({
      code: "model.insecureUrl",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      entry.url,
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(await readdir(path.join(tmp, "temp"))).toEqual([]);
  });

  it("follows a safe redirect before streaming the model", async () => {
    const body = Buffer.from("redirected model");
    const { server, baseURL } = await listen((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: "/model" });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end(body);
    });
    try {
      const entry: ModelEntry = {
        name: "redirected-safe.bin",
        url: `${baseURL}/start`,
        inputSize: 0,
      };
      const finalPath = await ensureModel(entry, tmp);
      expect(await readFile(finalPath)).toEqual(body);
    } finally {
      await closeServer(server);
    }
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
        byteSize: 4,
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
      const entry: ModelEntry = {
        name: "verify-ok.bin",
        url: baseURL,
        inputSize: 0,
        byteSize: body.length,
        sha256: sha,
      };
      const finalPath = await ensureModel(entry, tmp);
      expect(existsSync(finalPath)).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it("rejects a wrong advertised exact size before writing", async () => {
    const body = Buffer.from("small");
    const { server, baseURL } = await listen((_req, res) => {
      res.writeHead(200, { "content-length": String(body.length) });
      res.end(body);
    });
    try {
      const entry: ModelEntry = {
        name: "wrong-advertised-size.bin",
        url: baseURL,
        inputSize: 0,
        byteSize: body.length + 1,
      };
      await expect(ensureModel(entry, tmp)).rejects.toMatchObject({
        code: "model.sizeMismatch",
      });
      expect(await readdir(path.join(tmp, "temp"))).toEqual([]);
    } finally {
      await closeServer(server);
    }
  });

  it("stops before writing the chunk that crosses the exact-size ceiling", async () => {
    const { server, baseURL } = await listen((_req, res) => {
      res.writeHead(200, { "transfer-encoding": "chunked" });
      res.end(Buffer.from("12345"));
    });
    try {
      const entry: ModelEntry = {
        name: "stream-too-large.bin",
        url: baseURL,
        inputSize: 0,
        byteSize: 4,
      };
      await expect(ensureModel(entry, tmp)).rejects.toMatchObject({
        code: "model.sizeExceeded",
      });
      expect(await readdir(path.join(tmp, "temp"))).toEqual([]);
    } finally {
      await closeServer(server);
    }
  });

  it("rejects a short chunked response against the exact expected size", async () => {
    const { server, baseURL } = await listen((_req, res) => {
      res.writeHead(200, { "transfer-encoding": "chunked" });
      res.end(Buffer.from("123"));
    });
    try {
      const entry: ModelEntry = {
        name: "stream-too-short.bin",
        url: baseURL,
        inputSize: 0,
        byteSize: 4,
      };
      await expect(ensureModel(entry, tmp)).rejects.toMatchObject({
        code: "model.sizeMismatch",
      });
      expect(await readdir(path.join(tmp, "temp"))).toEqual([]);
    } finally {
      await closeServer(server);
    }
  });

  it("replaces an existing cache entry whose exact size is wrong", async () => {
    const body = Buffer.from("good");
    const sha = createHash("sha256").update(body).digest("hex");
    const { server, baseURL } = await listen((_req, res) => {
      res.writeHead(200, { "content-length": String(body.length) });
      res.end(body);
    });
    const entry: ModelEntry = {
      name: "wrong-cache-size.bin",
      url: baseURL,
      inputSize: 0,
      byteSize: body.length,
      sha256: sha,
    };
    await writeFile(path.join(tmp, entry.name), Buffer.from("bad"));
    try {
      const finalPath = await ensureModel(entry, tmp);
      expect(await readFile(finalPath)).toEqual(body);
    } finally {
      await closeServer(server);
    }
  });

  it("rejects a disabled model timeout", async () => {
    const entry: ModelEntry = {
      name: "no-timeout.bin",
      url: "https://example.com/model.bin",
      inputSize: 0,
    };
    await expect(
      ensureModel(entry, tmp, {
        budget: { timeout: 0, maxRetries: 0, retryIntervals: [] },
      }),
    ).rejects.toMatchObject({ code: "model.invalidBudget" });
  });

  it("honors cancellation after download and removes the staged file", async () => {
    const body = Buffer.from(new Uint8Array([1, 1, 2, 3, 5, 8]));
    const sha = createHash("sha256").update(body).digest("hex");
    const { server, baseURL } = await listen((_req, res) => {
      res.writeHead(200);
      res.end(body);
    });
    const ctrl = new AbortController();
    const logger: Logger = {
      handle: { path: path.join(tmp, "cancel.log"), verb: "model" },
      info: async (_stage, msg) => {
        if (msg.startsWith("downloaded")) ctrl.abort(new Error("stop"));
      },
      warn: async () => {},
      error: async () => {},
      debug: async () => {},
      close: async () => {},
    };
    try {
      const entry: ModelEntry = {
        name: "cancel-after-download.bin",
        url: baseURL,
        inputSize: 0,
        sha256: sha,
      };
      await expect(ensureModel(entry, tmp, { signal: ctrl.signal, logger })).rejects.toMatchObject({
        code: "cancelled",
      });
      expect(existsSync(path.join(tmp, entry.name))).toBe(false);
      expect(await readdir(path.join(tmp, "temp"))).toEqual([]);
    } finally {
      await closeServer(server);
    }
  });

  it("settles cancellation during streamed progress without an unhandled write error", async () => {
    const previous = Buffer.alloc(100, 1);
    const replacement = Buffer.from(new Uint8Array(100));
    const { server, baseURL } = await listen((_req, res) => {
      res.writeHead(200, { "content-length": String(replacement.length) });
      res.end(replacement);
    });
    const ctrl = new AbortController();
    const logger: Logger = {
      handle: { path: path.join(tmp, "cancel-progress.log"), verb: "model" },
      info: async () => {},
      warn: async () => {},
      error: async () => {},
      debug: async (_stage, _msg, data) => {
        if (Number(data?.received ?? 0) > 0) ctrl.abort(new Error("stop"));
      },
      close: async () => {},
    };
    const entry: ModelEntry = {
      name: "cancel-progress.bin",
      url: baseURL,
      inputSize: 0,
      byteSize: replacement.length,
    };
    await writeFile(path.join(tmp, entry.name), previous);
    try {
      await expect(
        ensureModel(entry, tmp, { force: true, signal: ctrl.signal, logger }),
      ).rejects.toMatchObject({ code: "cancelled" });
      expect(await readFile(path.join(tmp, entry.name))).toEqual(previous);
      expect(await readdir(path.join(tmp, "temp"))).toEqual([]);
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

  it("removes the staged file when force publish fails", async () => {
    const body = Buffer.from("replacement");
    const { server, baseURL } = await listen((_req, res) => {
      res.writeHead(200);
      res.end(body);
    });
    const entry: ModelEntry = { name: "blocked.bin", url: baseURL, inputSize: 0 };
    await mkdir(path.join(tmp, entry.name));
    try {
      await expect(ensureModel(entry, tmp, { force: true })).rejects.toMatchObject({
        code: "model.downloadFailed",
      });
      expect(await readdir(path.join(tmp, "temp"))).toEqual([]);
    } finally {
      await closeServer(server);
    }
  });
});
