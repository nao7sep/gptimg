import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfileError, RecipeError } from "../../src/errors.js";
import type { Logger } from "../../src/log/index.js";
import { NETWORK_DEFAULTS, fetchWithBudget, resolveNetworkForCall } from "../../src/network/index.js";
import { NetworkSchema, formatNetworkZodError } from "../../src/network/schema.js";

function testLogger(): Logger {
  return {
    handle: { path: "test.log", verb: "generate" },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    close: vi.fn(),
  };
}

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

describe("resolveNetworkForCall", () => {
  it("rejects invalid profile.network values", async () => {
    await expect(
      resolveNetworkForCall(
        {
          provider: "openai",
          apiKey: "sk-test",
          network: { imageGenerate: { timeout: "slow" } },
        },
        undefined,
      ),
    ).rejects.toBeInstanceOf(ProfileError);
  });

  it("rejects invalid recipe.network values after overrides", async () => {
    for (const [name, recipe] of [
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
    ]) {
      await expect(
        resolveNetworkForCall(
          { provider: "openai", apiKey: "sk-test" },
          recipe,
        ),
        name,
      ).rejects.toBeInstanceOf(RecipeError);
    }
  });

  it("does not log deprecation warnings for current profile shapes", async () => {
    const logger = testLogger();

    await resolveNetworkForCall(
      {
        provider: "openai",
        apiKey: "sk-test",
        network: { imageGenerate: { timeout: 1234 } },
      },
      undefined,
      logger,
    );

    expect(logger.warn).not.toHaveBeenCalled();
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
      expect(formatNetworkZodError(result.error)).toContain("imageGenerate.timeout");
      expect(formatNetworkZodError(result.error)).toContain(
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
  ): Promise<{ server: http.Server; baseURL: string; calls: () => number }> {
    let calls = 0;
    const { server, baseURL } = await listen((req, res) => {
      calls += 1;
      if (calls <= holdCount) {
        // Hold the request open. When the client aborts, the socket closes;
        // the handler exits without writing — no resources to release.
        req.on("close", () => {});
        return;
      }
      res.writeHead(200);
      res.end(okBody);
    });
    return { server, baseURL, calls: () => calls };
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
        timeout: 1000,
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
        timeout: 1000,
        maxRetries: 2,
        retryIntervals: [],
      }),
    ).rejects.toMatchObject({ status: 404 });
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
        { timeout: 1000, maxRetries: 0, retryIntervals: [] },
        { signal: ctrl.signal },
      ),
    ).rejects.toMatchObject({
      name: "AbortError",
      code: "cancelled",
    });
  });

  it("uses the budget timeout to abort slow responses", async () => {
    const { server, baseURL } = await listenHoldThenOk(1);
    servers.push(server);

    await expect(
      fetchWithBudget(baseURL, {
        timeout: 100,
        maxRetries: 0,
        retryIntervals: [],
      }),
    ).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });

  it("retries per-attempt timeout failures", async () => {
    const { server, baseURL, calls } = await listenHoldThenOk(1);
    servers.push(server);

    await expect(
      fetchWithBudget(baseURL, {
        timeout: 100,
        maxRetries: 1,
        retryIntervals: [],
      }),
    ).resolves.toEqual(new Uint8Array(Buffer.from("ok")));
    expect(calls()).toBe(2);
  });
});
