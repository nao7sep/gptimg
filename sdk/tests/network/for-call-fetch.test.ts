import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GptImgError } from "../../src/errors.ts";
import { NETWORK_DEFAULTS, fetchWithBudget, resolveNetworkForCall } from "../../src/network/index.ts";
import { formatZodError } from "../../src/internal/zodError.ts";
import { NetworkSchema } from "../../src/network/schema.ts";
import { validatePolicy } from "../../src/policy/schemas.ts";

function listen(
  handler: http.RequestListener,
): Promise<{ server: http.Server; baseURL: string }> {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, baseURL: `http://127.0.0.1:${address.port}` });
    });
  });
}

// A server that answers at once; the product's own download deadline bounds each call.
const timeout = NETWORK_DEFAULTS.imageDownload.timeout;

describe("resolveNetworkForCall", () => {
  it("rejects invalid policy.network values", () => {
    const cases: [string, unknown][] = [
      [
        "unknown category",
        { network: { imageGenrate: { timeout: 120000 } } },
      ],
      [
        "unknown budget field",
        { network: { imageGenerate: { retryInterval: [1000] } } },
      ],
      [
        "bad value type",
        { network: { imageGenerate: { timeout: "slow" } } },
      ],
    ];
    for (const [name, policy] of cases) {
      expect(() => validatePolicy(policy), name).toThrow(GptImgError);
    }
  });

  it("returns defaults when no policy.network is provided", () => {
    const cfg = resolveNetworkForCall({});
    expect(cfg).toEqual(NETWORK_DEFAULTS);
  });
});

describe("network schema errors", () => {
  it("formats nested validation paths", () => {
    const result = NetworkSchema.safeParse({
      imageGenerate: {
        timeout: "slow",
        retryIntervals: [100, "bad"],
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatZodError(result.error)).toContain("imageGenerate.timeout");
      expect(formatZodError(result.error)).toContain(
        "imageGenerate.retryIntervals.1",
      );
    }
  });

  it("rejects unknown network categories and budget fields", () => {
    expect(
      NetworkSchema.safeParse({ imageGenrate: { timeout: 1000 } }).success,
    ).toBe(false);
    expect(
      NetworkSchema.safeParse({
        imageGenerate: { retryInterval: [1000] },
      }).success,
    ).toBe(false);
  });
});

describe("fetchWithBudget", () => {
  const servers: http.Server[] = [];

  /**
   * Listen on a request handler that holds the first `holdCount` requests
   * open until the client disconnects (i.e. its per-attempt timeout
   * aborts), then responds 200 with `okBody` for every subsequent request.
   *
   * Holding the connection open means the budget timeout is the only thing
   * that can terminate the fetch — there is no scheduler race between a
   * delayed server response and a small client timeout.
   */
  async function listenHoldThenOk(
    holdCount: number,
    okBody = "ok",
  ): Promise<{ server: http.Server; baseURL: string; calls: () => number; admitted: Promise<void> }> {
    let calls = 0;
    let admit!: () => void;
    const admitted = new Promise<void>((resolve) => { admit = resolve; });
    const { server, baseURL } = await listen((req, res) => {
      calls += 1;
      admit();
      if (calls <= holdCount) {
        // Hold the request open. When the client aborts, the socket closes;
        // the handler exits without writing — no resources to release.
        req.on("close", () => {});
        return;
      }
      res.writeHead(200);
      res.end(okBody);
    });
    return { server, baseURL, calls: () => calls, admitted };
  }

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            // Drop any sockets the held-open tests left dangling so
            // server.close() does not wait on them.
            server.closeAllConnections();
            server.close((err) => (err ? reject(err) : resolve()));
          }),
      ),
    );
    servers.length = 0;
  });

  it("fetches bytes from a successful response", async () => {
    const { server, baseURL } = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.from([1, 2, 3]));
    });
    servers.push(server);

    await expect(fetchWithBudget(baseURL, NETWORK_DEFAULTS.imageDownload)).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("retries retryable HTTP errors and honors the download budget", async () => {
    let calls = 0;
    const { server, baseURL } = await listen((_req, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(503, { "retry-after-ms": "0" });
        res.end("try again");
        return;
      }
      res.writeHead(200);
      res.end("ok");
    });
    servers.push(server);

    await expect(
      fetchWithBudget(baseURL, {
        timeout,
        maxRetries: 1,
        retryIntervals: [],
      }),
    ).resolves.toEqual(new Uint8Array(Buffer.from("ok")));
    expect(calls).toBe(2);
  });

  it("throws non-retryable HTTP errors without retrying", async () => {
    let calls = 0;
    const { server, baseURL } = await listen((_req, res) => {
      calls += 1;
      res.writeHead(404);
      res.end("missing");
    });
    servers.push(server);

    await expect(
      fetchWithBudget(baseURL, {
        timeout,
        maxRetries: 2,
        retryIntervals: [],
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(calls).toBe(1);
  });

  it("retries transient Cloudflare-origin 5xx (520)", async () => {
    let calls = 0;
    const { server, baseURL } = await listen((_req, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(520);
        res.end("cf edge");
        return;
      }
      res.writeHead(200);
      res.end("ok");
    });
    servers.push(server);

    await expect(
      fetchWithBudget(baseURL, { timeout, maxRetries: 1, retryIntervals: [] }),
    ).resolves.toEqual(new Uint8Array(Buffer.from("ok")));
    expect(calls).toBe(2);
  });

  it("does not retry persistent Cloudflare 526 (invalid SSL certificate)", async () => {
    let calls = 0;
    const { server, baseURL } = await listen((_req, res) => {
      calls += 1;
      res.writeHead(526);
      res.end("bad cert");
    });
    servers.push(server);

    await expect(
      fetchWithBudget(baseURL, { timeout, maxRetries: 2, retryIntervals: [] }),
    ).rejects.toMatchObject({ status: 526 });
    expect(calls).toBe(1);
  });

  it("aborts when the parent signal is already aborted", async () => {
    const { server, baseURL } = await listen((_req, res) => {
      res.writeHead(200);
      res.end("late");
    });
    servers.push(server);
    const ctrl = new AbortController();
    ctrl.abort(new Error("stop"));

    await expect(
      fetchWithBudget(
        baseURL,
        { timeout, maxRetries: 0, retryIntervals: [] },
        { signal: ctrl.signal },
      ),
    ).rejects.toMatchObject({
      code: "cancelled",
    });
  });

  it("uses the budget timeout to abort an admitted slow response", async () => {
    const { server, baseURL, admitted, calls } = await listenHoldThenOk(1);
    servers.push(server);
    const timeout = new AbortController();
    const timeoutSignal = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const operation = fetchWithBudget(baseURL, { timeout: 100, maxRetries: 0, retryIntervals: [] });
    const rejected = expect(operation).rejects.toMatchObject({ name: "TimeoutError" });
    void rejected.catch(() => undefined);
    try {
      await admitted;
      expect(calls()).toBe(1);
      expect(timeoutSignal).toHaveBeenCalledWith(100);
      timeout.abort(new DOMException("held response timed out", "TimeoutError"));
      await rejected;
    } finally {
      timeout.abort();
      await operation.catch(() => undefined);
      timeoutSignal.mockRestore();
    }
  });

  it("retries per-attempt timeout failures after request admission", async () => {
    const { server, baseURL, calls, admitted } = await listenHoldThenOk(1);
    servers.push(server);
    const timeouts: AbortController[] = [];
    const timeoutSignal = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const timeout = new AbortController();
      timeouts.push(timeout);
      return timeout.signal;
    });
    const operation = fetchWithBudget(baseURL, { timeout: 250, maxRetries: 1, retryIntervals: [] });
    // Observe rejection immediately, including a setup failure before admission.
    void operation.catch(() => undefined);
    try {
      await admitted;
      expect(timeouts).toHaveLength(1);
      timeouts[0]!.abort(new DOMException("held attempt timed out", "TimeoutError"));
      await expect(operation).resolves.toEqual(new Uint8Array(Buffer.from("ok")));
      expect(calls()).toBe(2);
      expect(timeouts).toHaveLength(2);
      expect(timeoutSignal.mock.calls).toEqual([[250], [250]]);
    } finally {
      for (const timeout of timeouts) timeout.abort();
      await operation.catch(() => undefined);
      timeoutSignal.mockRestore();
    }
  });
});
