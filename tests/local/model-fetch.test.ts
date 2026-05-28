import http from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultModelsDir } from "../../src/internal/paths.js";
import { ensureModel } from "../../src/local/models/fetch.js";
import type { ModelEntry } from "../../src/local/models/registry.js";

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

  it("downloads to .partial and atomically renames to the final name", async () => {
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
      expect(existsSync(`${finalPath}.partial`)).toBe(false);
      const got = await readFile(finalPath);
      expect(Array.from(new Uint8Array(got))).toEqual(Array.from(new Uint8Array(body)));
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
      };
      await writeFile(path.join(tmp, entry.name), Buffer.from([5, 5, 5, 5]));
      const finalPath = await ensureModel(entry, tmp);
      expect(finalPath).toBe(path.join(tmp, "cached.bin"));
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it("cleans up a stale .partial from a prior interrupted run before downloading", async () => {
    const body = Buffer.from(new Uint8Array([3, 3, 3]));
    const { server, baseURL } = await listen((_req, res) => {
      res.writeHead(200);
      res.end(body);
    });
    try {
      const entry: ModelEntry = {
        name: "partial-cleanup.bin",
        url: baseURL,
        inputSize: 0,
      };
      await writeFile(
        path.join(tmp, `${entry.name}.partial`),
        Buffer.from("garbage from a prior run"),
      );
      const finalPath = await ensureModel(entry, tmp);
      expect(finalPath).toBe(path.join(tmp, entry.name));
      expect(existsSync(`${finalPath}.partial`)).toBe(false);
      const got = await readFile(finalPath);
      expect(Array.from(new Uint8Array(got))).toEqual(Array.from(new Uint8Array(body)));
    } finally {
      await closeServer(server);
    }
  });

  it("removes the .partial when the download itself fails", async () => {
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
      expect(existsSync(path.join(tmp, `${entry.name}.partial`))).toBe(false);
    } finally {
      await closeServer(server);
    }
  });
});
