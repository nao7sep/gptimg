import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureModel,
  fileSha256,
  hostTag,
  modelWholeTimeoutMs,
  stagingPathFor,
} from "../../src/local/models/fetch.ts";
import { BIREFNET, type ModelEntry } from "../../src/local/models/registry.ts";
import type { Logger } from "../../src/events/index.ts";

/** The pins of a body a test serves. */
const pinned = (body: Buffer | string) => {
  const bytes = Buffer.from(body);
  return { byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
};
/** A digest for an entry whose download never reaches the hash check. */
const UNREACHED = "0".repeat(64);
const NOT_FETCHED = { byteSize: 4, sha256: UNREACHED };

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

describe("stagingPathFor", () => {
  it("names the staged file <stem>-<hostTag>-<pid>-<random>.tmp inside temp/, derived from the model's stem", () => {
    const p = stagingPathFor("/cache", "birefnet-general-fp16-v1.onnx");
    expect(path.dirname(p)).toBe(path.join("/cache", "temp"));
    expect(path.basename(p)).toMatch(
      new RegExp(`^birefnet-general-fp16-v1-${hostTag()}-${process.pid}-[A-Za-z0-9_-]{21}\\.tmp$`),
    );
  });
});

describe("modelWholeTimeoutMs", () => {
  it("is finite and scales with artifact size and possible attempts", () => {
    const small = modelWholeTimeoutMs(1024, 0);
    const large = modelWholeTimeoutMs(BIREFNET.byteSize, 0);
    const retried = modelWholeTimeoutMs(BIREFNET.byteSize, 2);
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
    const events: { stage: string; event: string }[] = [];
    const logger: Logger = {
      verb: "model",
      emit: (_level, stage, body) => void events.push({ stage, event: body.event }),
      progress: () => {},
      addCredential: () => {},
    };
    // Spy stderr for the duration of the download; the SDK must not touch it.
    const stderrSpy = vi.fn(() => true);
    process.stderr.write = stderrSpy as unknown as typeof process.stderr.write;
    try {
      const entry: ModelEntry = { name: "prog.bin", url: baseURL, inputSize: 0, ...pinned(body) };
      await ensureModel(entry, tmp, { logger });
    } finally {
      await closeServer(server);
    }
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(events.every((e) => e.stage === "download")).toBe(true);
    // The one-time download is announced before any request, then progresses.
    expect(events.map((e) => e.event)).toEqual(["model.download.needed", "model.download.start", "model.download.done"]);
  });

  it("removes staged downloads whose process is gone and keeps those still in flight", async () => {
    const nanoid21 = "abcDEF123_-abcDEF123_";
    const tag = hostTag();
    const tempDir = path.join(tmp, "temp");
    await mkdir(tempDir, { recursive: true });
    // macOS caps pids below 100000 and Linux below 2^22, so 99999999 never runs.
    const abandoned = `birefnet-${tag}-99999999-${nanoid21}.tmp`;
    const ours = `birefnet-${tag}-${process.pid}-${nanoid21}.tmp`;
    const parents = `birefnet-${tag}-${process.ppid}-${nanoid21}.tmp`;
    // A dead-here pid tagged for a different host: a caller's `modelsDir` can point
    // several hosts at the same shared directory, and this host's pid table
    // says nothing about whether that other host's download is still running,
    // so it must survive the sweep untouched.
    const otherHostAbandoned = `birefnet-deadbeef-99999999-${nanoid21}.tmp`;
    const unrelated = "notes.txt";
    for (const name of [abandoned, ours, parents, otherHostAbandoned, unrelated]) {
      await writeFile(path.join(tempDir, name), "x");
    }
    await writeFile(path.join(tmp, "cached.bin"), "12345");

    // A cache hit still sweeps, so leftovers go even when nothing downloads.
    const entry: ModelEntry = { name: "cached.bin", url: "https://example.invalid/m", inputSize: 0, byteSize: 5, sha256: UNREACHED };
    await expect(ensureModel(entry, tmp)).resolves.toBe(path.join(tmp, "cached.bin"));
    expect((await readdir(tempDir)).sort()).toEqual(
      [ours, parents, otherHostAbandoned, unrelated].sort(),
    );
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
        ...pinned(body),
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

  it("reports a models folder it cannot create as a file-system failure, not an unexpected one", async () => {
    const file = path.join(tmp, "a-file");
    await writeFile(file, "x");
    const entry: ModelEntry = { name: "test.bin", url: "https://example.com/model.bin", inputSize: 0, ...NOT_FETCHED };
    const err = await ensureModel(entry, path.join(file, "models")).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "GptImgError", kind: "unavailable", effect: "none", subject: path.join(file, "models") });
    expect((err as { code: string }).code).toMatch(/^fs\./);
  });

  it("refuses a non-https remote URL before any byte is fetched", async () => {
    const entry: ModelEntry = {
      name: "insecure.bin",
      url: "http://example.com/model.bin",
      inputSize: 0,
      ...NOT_FETCHED,
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
      ...NOT_FETCHED,
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

  it.each([
    { label: "missing redirect Location", status: 302, headers: {}, calls: 1, code: "model.badRedirect", message: "did not include a Location" },
    { label: "exhausted redirects", status: 302, headers: { location: "/again" }, calls: 11, code: "model.badRedirect", message: "Too many redirects" },
    { label: "invalid content length", status: 200, headers: { "content-length": "invalid" }, calls: 1, code: "model.integrity", message: "Invalid model Content-Length" },
    { label: "unsafe content length", status: 200, headers: { "content-length": "9007199254740992" }, calls: 1, code: "model.integrity", message: "not a safe integer" },
    { label: "oversized content length", status: 200, headers: { "content-length": "5" }, calls: 1, code: "model.integrity", message: "exceeds the 4-byte limit" },
    { label: "mismatched content length", status: 200, headers: { "content-length": "3" }, calls: 1, code: "model.integrity", message: "expected exactly 4" },
  ])("cancels the response body for $label, preserving refusal if cleanup fails", async ({ status, headers, calls, code, message }) => {
    const cancellations: ReturnType<typeof vi.fn>[] = [];
    const fetcher = vi.fn(async () => {
      const cancel = vi.fn(() => {
        if (cancellations.length === calls) throw new Error("cleanup failed");
      });
      cancellations.push(cancel);
      return new Response(new ReadableStream<Uint8Array>({ cancel }), { status, headers });
    });
    vi.stubGlobal("fetch", fetcher);
    const entry: ModelEntry = {
      name: "refused-body.bin", url: "https://example.com/model.bin", inputSize: 0, ...NOT_FETCHED,
    };
    await expect(ensureModel(entry, tmp)).rejects.toMatchObject({ code, message: expect.stringContaining(message) });
    expect(fetcher).toHaveBeenCalledTimes(calls);
    expect(cancellations).toHaveLength(calls);
    for (const cancel of cancellations) expect(cancel).toHaveBeenCalledOnce();
    expect(existsSync(path.join(tmp, entry.name))).toBe(false);
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
        ...pinned(body),
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
        sha256: UNREACHED,
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
        ...NOT_FETCHED,
      };
      await expect(ensureModel(entry, tmp)).rejects.toMatchObject({
        code: "model.httpStatus",
      });
      expect(existsSync(path.join(tmp, entry.name))).toBe(false);
      // The staged copy in temp/ is cleaned up on failure, not left behind.
      expect(await readdir(path.join(tmp, "temp"))).toEqual([]);
    } finally {
      await closeServer(server);
    }
  });

  it("keeps the server's complete error body on a failed download", async () => {
    const detail = `Entry not found: ${"x".repeat(2000)}\nrevision 534d3c8`;
    const { server, baseURL } = await listen((_req, res) => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end(detail);
    });
    try {
      const entry: ModelEntry = { name: "missing-body.bin", url: baseURL, inputSize: 0, ...NOT_FETCHED };
      const err = (await ensureModel(entry, tmp).then(
        () => expect.fail("the download should fail"),
        (e: unknown) => e,
      )) as Error & { cause?: Error };
      expect(err).toMatchObject({ code: "model.httpStatus", details: { status: 404 } });
      expect(err.message).toContain(`HTTP 404: ${detail}`);
      expect(err.cause?.message).toBe(`HTTP 404: ${detail}`);
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
        byteSize: body.length,
      };
      await expect(ensureModel(entry, tmp)).rejects.toMatchObject({
        code: "model.integrity",
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
        sha256: UNREACHED,
      };
      await expect(ensureModel(entry, tmp)).rejects.toMatchObject({
        code: "model.integrity",
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
        sha256: UNREACHED,
      };
      await expect(ensureModel(entry, tmp)).rejects.toMatchObject({
        code: "model.integrity",
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
        sha256: UNREACHED,
      };
      await expect(ensureModel(entry, tmp)).rejects.toMatchObject({
        code: "model.integrity",
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

  it("refuses an advertised size beyond the exact expected size without reading the body", async () => {
    const fetcher = vi.fn(async () =>
      new Response("x".repeat(8), { status: 200, headers: { "content-length": "8" } }),
    );
    vi.stubGlobal("fetch", fetcher);
    const entry: ModelEntry = {
      name: "oversized.bin",
      url: "https://example.com/model.bin",
      inputSize: 0,
      byteSize: 4,
      sha256: UNREACHED,
    };
    await expect(ensureModel(entry, tmp)).rejects.toMatchObject({ code: "model.integrity" });
    expect(existsSync(path.join(tmp, entry.name))).toBe(false);
    expect(await readdir(path.join(tmp, "temp"))).toEqual([]);
  });

  it.each(["12abc", "99999999999999999999"])("refuses a malformed Content-Length of %j", async (length) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("body", { status: 200, headers: { "content-length": length } })),
    );
    const entry: ModelEntry = {
      name: "bad-length.bin",
      url: "https://example.com/model.bin",
      inputSize: 0,
      ...pinned("body"),
    };
    await expect(ensureModel(entry, tmp)).rejects.toMatchObject({ code: "model.integrity" });
    expect(existsSync(path.join(tmp, entry.name))).toBe(false);
  });

  it("refuses a redirect without a Location header", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302 })));
    const entry: ModelEntry = {
      name: "no-location.bin",
      url: "https://example.com/model.bin",
      inputSize: 0,
      ...NOT_FETCHED,
    };
    await expect(ensureModel(entry, tmp)).rejects.toMatchObject({ code: "model.badRedirect" });
  });

  it("stops after ten redirects", async () => {
    let hops = 0;
    const fetcher = vi.fn(async () => {
      hops += 1;
      return new Response(null, { status: 307, headers: { location: `/hop-${hops}` } });
    });
    vi.stubGlobal("fetch", fetcher);
    const entry: ModelEntry = {
      name: "redirect-loop.bin",
      url: "https://example.com/model.bin",
      inputSize: 0,
      ...NOT_FETCHED,
    };
    await expect(ensureModel(entry, tmp)).rejects.toMatchObject({
      code: "model.badRedirect",
      message: expect.stringContaining("Too many redirects"),
    });
    expect(fetcher).toHaveBeenCalledTimes(11);
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
      verb: "model",
      emit: (_level, _stage, body) => {
        if (body.event === "model.download.done") ctrl.abort(new Error("stop"));
      },
      progress: () => {},
      addCredential: () => {},
    };
    try {
      const entry: ModelEntry = {
        name: "cancel-after-download.bin",
        url: baseURL,
        inputSize: 0,
        sha256: sha,
        byteSize: body.length,
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
      verb: "model",
      emit: () => {},
      progress: (_stage, done) => {
        if (done > 0) ctrl.abort(new Error("stop"));
      },
      addCredential: () => {},
    };
    const entry: ModelEntry = {
      name: "cancel-progress.bin",
      url: baseURL,
      inputSize: 0,
      byteSize: replacement.length,
      sha256: pinned(replacement).sha256,
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
      res.end(Buffer.from("AAAA"));
    });
    try {
      const entry: ModelEntry = { name: "force.bin", url: baseURL, inputSize: 0, ...pinned("AAAA") };
      const p1 = await ensureModel(entry, tmp);
      expect((await readFile(p1)).toString()).toBe("AAAA");
      // A file of the right size is a cache hit, damaged or not, until force replaces it.
      await writeFile(p1, "ZZZZ");
      await ensureModel(entry, tmp);
      expect(hits).toBe(1);
      expect((await readFile(p1)).toString()).toBe("ZZZZ");
      const p2 = await ensureModel(entry, tmp, { force: true });
      expect((await readFile(p2)).toString()).toBe("AAAA");
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
    const entry: ModelEntry = { name: "blocked.bin", url: baseURL, inputSize: 0, ...pinned(body) };
    await mkdir(path.join(tmp, entry.name));
    try {
      // Renaming over a folder fails with the filesystem's own cause.
      await expect(ensureModel(entry, tmp, { force: true })).rejects.toMatchObject({
        kind: "unavailable",
        code: expect.stringMatching(/^fs\./),
        subject: path.join(tmp, entry.name),
      });
      expect(await readdir(path.join(tmp, "temp"))).toEqual([]);
    } finally {
      await closeServer(server);
    }
  });
});
