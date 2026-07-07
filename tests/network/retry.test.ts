import { describe, expect, it, vi } from "vitest";
import { AbortError } from "../../src/errors.js";
import { callWithRetry, isAbortError } from "../../src/network/retry.js";
import type { NetworkBudget } from "../../src/network/defaults.js";
import type { Logger } from "../../src/log/index.js";

const fast: NetworkBudget = {
  timeout: 60_000,
  maxRetries: 3,
  retryIntervals: [1, 1, 1],
};

function http(status: number, headers: Record<string, string> = {}): Error {
  const e = new Error(`HTTP ${status}`);
  Object.assign(e, { status, headers });
  return e;
}

function netCode(code: string): Error {
  const e = new Error(`network error ${code}`);
  Object.assign(e, { code });
  return e;
}

function named(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

/** Minimal Logger whose warn() is a spy; other methods are inert. */
function fakeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  const noop = vi.fn(async () => {});
  const warn = vi.fn(async () => {});
  return {
    handle: { path: "/dev/null", verb: "generate" },
    info: noop,
    warn,
    error: noop,
    debug: noop,
    close: noop,
  } as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
}

describe("callWithRetry", () => {
  it("returns immediately on success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const out = await callWithRetry(
      { budgetName: "imageGenerate", budget: fast },
      fn,
    );
    expect(out).toBe("ok");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("retries on 429 up to maxRetries", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(http(429))
      .mockRejectedValueOnce(http(429))
      .mockResolvedValueOnce("ok");
    const out = await callWithRetry(
      { budgetName: "imageGenerate", budget: fast },
      fn,
    );
    expect(out).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("retries on 500/502/503/504 and 408", async () => {
    for (const status of [500, 502, 503, 504, 408]) {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(http(status))
        .mockResolvedValueOnce("ok");
      const out = await callWithRetry(
        { budgetName: "imageGenerate", budget: fast },
        fn,
      );
      expect(out, `status ${status}`).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    }
  });

  // 409 is a deterministic conflict for this toolkit's endpoints, not a
  // transient boundary — retrying it only burns the budget before failing.
  it("does NOT retry on 400/401/403/404/409", async () => {
    for (const status of [400, 401, 403, 404, 409]) {
      const fn = vi.fn().mockRejectedValue(http(status));
      await expect(
        callWithRetry({ budgetName: "imageGenerate", budget: fast }, fn),
      ).rejects.toMatchObject({ status });
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  it("retries on transient network codes", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(netCode("ECONNRESET"))
      .mockResolvedValueOnce("ok");
    const out = await callWithRetry(
      { budgetName: "imageDownload", budget: fast },
      fn,
    );
    expect(out).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws when maxRetries is exhausted", async () => {
    const fn = vi.fn().mockRejectedValue(http(503));
    await expect(
      callWithRetry({ budgetName: "imageGenerate", budget: fast }, fn),
    ).rejects.toMatchObject({ status: 503 });
    // initial + 3 retries
    expect(fn).toHaveBeenCalledTimes(1 + fast.maxRetries);
  });

  it("does not retry when maxRetries is 0", async () => {
    const fn = vi.fn().mockRejectedValue(http(503));
    const budget: NetworkBudget = { ...fast, maxRetries: 0 };
    await expect(
      callWithRetry({ budgetName: "imageGenerate", budget }, fn),
    ).rejects.toMatchObject({ status: 503 });
    expect(fn).toHaveBeenCalledOnce();
  });

  it("aborts immediately when the signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const fn = vi.fn();
    await expect(
      callWithRetry(
        { budgetName: "imageGenerate", budget: fast, signal: ctrl.signal },
        fn,
      ),
    ).rejects.toSatisfy(isAbortError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("does not retry on AbortError thrown from fn", async () => {
    const abortErr = new Error("cancelled");
    abortErr.name = "AbortError";
    const fn = vi.fn().mockRejectedValue(abortErr);
    const err = await callWithRetry(
      { budgetName: "imageGenerate", budget: fast },
      fn,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AbortError);
    expect(err).toMatchObject({
      name: "AbortError",
      errorType: "abort",
      code: "cancelled",
    });
    expect(fn).toHaveBeenCalledOnce();
  });

  it("aborts during retry sleep", async () => {
    const ctrl = new AbortController();
    const fn = vi.fn().mockRejectedValue(http(503));
    setTimeout(() => ctrl.abort(new Error("stop sleeping")), 5);

    await expect(
      callWithRetry(
        {
          budgetName: "imageGenerate",
          budget: { ...fast, retryIntervals: [50] },
          signal: ctrl.signal,
        },
        fn,
      ),
    ).rejects.toMatchObject({
      name: "AbortError",
      code: "cancelled",
      message: "stop sleeping",
    });
    expect(fn).toHaveBeenCalledOnce();
  });

  it("retries even when retryIntervals is empty (immediate retry)", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(http(503))
      .mockResolvedValueOnce("ok");
    const budget: NetworkBudget = { ...fast, retryIntervals: [] };
    const out = await callWithRetry(
      { budgetName: "imageGenerate", budget },
      fn,
    );
    expect(out).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("honors Retry-After header (seconds) over scheduled wait", async () => {
    const headers = new Headers({ "retry-after": "0" });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("429"), { status: 429, headers }),
      )
      .mockResolvedValueOnce("ok");
    const out = await callWithRetry(
      { budgetName: "imageGenerate", budget: fast },
      fn,
    );
    expect(out).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("honors retry-after-ms header in preference to retry-after", async () => {
    const headers = new Headers({
      "retry-after-ms": "0",
      "retry-after": "9999",
    });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("429"), { status: 429, headers }),
      )
      .mockResolvedValueOnce("ok");
    const out = await callWithRetry(
      { budgetName: "imageGenerate", budget: fast },
      fn,
    );
    expect(out).toBe("ok");
  });

  it("reuses the last retryIntervals entry when count exceeds list", async () => {
    // schedule [1, 1, 1] with maxRetries 5 → still finishes by reusing 1
    const fn = vi
      .fn()
      .mockRejectedValueOnce(http(503))
      .mockRejectedValueOnce(http(503))
      .mockRejectedValueOnce(http(503))
      .mockRejectedValueOnce(http(503))
      .mockResolvedValueOnce("ok");
    const budget: NetworkBudget = { ...fast, maxRetries: 5 };
    const out = await callWithRetry(
      { budgetName: "imageGenerate", budget },
      fn,
    );
    expect(out).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(5);
  });

  // The status-less network/SDK error classification path (isRetryableError).
  // These errors carry no `status`, so retryability hinges on `code`/`name`.
  it("retries TimeoutError (name-based, no status/code)", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(named("TimeoutError"))
      .mockResolvedValueOnce("ok");
    const out = await callWithRetry(
      { budgetName: "imageDownload", budget: fast },
      fn,
    );
    expect(out).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries OpenAI SDK connection errors by name (no status)", async () => {
    for (const name of ["APIConnectionError", "APIConnectionTimeoutError"]) {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(named(name))
        .mockResolvedValueOnce("ok");
      const out = await callWithRetry(
        { budgetName: "imageGenerate", budget: fast },
        fn,
      );
      expect(out, name).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    }
  });

  it("does NOT retry an unknown network code", async () => {
    const fn = vi.fn().mockRejectedValue(netCode("ESOMETHINGELSE"));
    await expect(
      callWithRetry({ budgetName: "imageDownload", budget: fast }, fn),
    ).rejects.toMatchObject({ code: "ESOMETHINGELSE" });
    expect(fn).toHaveBeenCalledOnce();
  });

  it("does NOT retry a status-less Error with an unrecognized name", async () => {
    const fn = vi.fn().mockRejectedValue(named("SyntaxError"));
    await expect(
      callWithRetry({ budgetName: "imageGenerate", budget: fast }, fn),
    ).rejects.toMatchObject({ name: "SyntaxError" });
    expect(fn).toHaveBeenCalledOnce();
  });

  // A non-Error rejection value (no status, not an Error) is not retryable.
  it("does NOT retry a non-Error thrown value", async () => {
    const fn = vi.fn().mockRejectedValue("plain string failure");
    await expect(
      callWithRetry({ budgetName: "imageGenerate", budget: fast }, fn),
    ).rejects.toBe("plain string failure");
    expect(fn).toHaveBeenCalledOnce();
  });

  // Retry-After supplied as an HTTP-date string (not a number of seconds): the
  // header parser falls back to Date.parse and waits until that instant.
  it("honors a Retry-After HTTP-date header", async () => {
    // 0ms in the past → non-negative-after-now check yields a ~0 wait; the
    // point is that the date branch is taken without throwing.
    const when = new Date(Date.now() + 5).toUTCString();
    const headers = new Headers({ "retry-after": when });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("429"), { status: 429, headers }),
      )
      .mockResolvedValueOnce("ok");
    const out = await callWithRetry(
      { budgetName: "imageGenerate", budget: fast },
      fn,
    );
    expect(out).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  // A Retry-After value that is neither a finite number nor a parseable date
  // falls through to the scheduled wait (the schedule still drives the retry).
  it("falls back to the schedule on an unparseable Retry-After", async () => {
    const headers = new Headers({ "retry-after": "soon-ish" });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("503"), { status: 503, headers }),
      )
      .mockResolvedValueOnce("ok");
    const out = await callWithRetry(
      { budgetName: "imageGenerate", budget: fast },
      fn,
    );
    expect(out).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  // Retry-After read from a plain header object (not a Headers instance) — e.g.
  // an SDK error whose `headers` is a Record. readHeader must match case-
  // insensitively over the object's own keys.
  it("reads Retry-After from a plain-object headers bag (case-insensitive)", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(http(429, { "Retry-After-Ms": "0" }))
      .mockResolvedValueOnce("ok");
    const out = await callWithRetry(
      { budgetName: "imageGenerate", budget: fast },
      fn,
    );
    expect(out).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  // A malformed retry-after-ms (negative / non-finite) is ignored, and the
  // parser falls through to the retry-after (seconds) value instead.
  it("ignores a malformed retry-after-ms and falls back to retry-after seconds", async () => {
    const headers = new Headers({
      "retry-after-ms": "-1",
      "retry-after": "0",
    });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("429"), { status: 429, headers }),
      )
      .mockResolvedValueOnce("ok");
    const out = await callWithRetry(
      { budgetName: "imageGenerate", budget: fast },
      fn,
    );
    expect(out).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("logs a structured warn record before each retry", async () => {
    const logger = fakeLogger();
    const headers = new Headers({ "retry-after-ms": "0" });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("429"), { status: 429, headers }),
      )
      .mockResolvedValueOnce("ok");
    const out = await callWithRetry(
      { budgetName: "imageGenerate", budget: fast, logger },
      fn,
    );
    expect(out).toBe("ok");
    expect(logger.warn).toHaveBeenCalledOnce();
    const [stage, message, data] = logger.warn.mock.calls[0]!;
    expect(stage).toBe("retry");
    expect(message).toContain("retrying imageGenerate");
    expect(data).toMatchObject({
      budget: "imageGenerate",
      attempt: 1,
      maxRetries: fast.maxRetries,
      reason: 429,
      retryAfterHeader: true,
    });
  });

  // The reason field falls back to the Error name when there is no status.
  it("logs the error name as the reason when there is no status", async () => {
    const logger = fakeLogger();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(netCode("ECONNRESET"))
      .mockResolvedValueOnce("ok");
    await callWithRetry(
      { budgetName: "imageDownload", budget: fast, logger },
      fn,
    );
    const [, , data] = logger.warn.mock.calls[0]!;
    expect(data).toMatchObject({ reason: "Error", retryAfterHeader: false });
  });

  // Covers abortableSleep's aborted-at-entry guard: the signal aborts while the
  // pre-sleep logger.warn await is pending, so the sleep is entered already
  // aborted and rejects synchronously rather than scheduling a timer.
  it("aborts at sleep entry when the signal fires during pre-sleep logging", async () => {
    const ctrl = new AbortController();
    const logger = fakeLogger();
    // Abort from inside warn(), i.e. between the abort re-check after fn() and
    // the abortableSleep() call.
    logger.warn.mockImplementation(async () => {
      ctrl.abort(new Error("aborted while logging"));
    });
    const fn = vi.fn().mockRejectedValue(http(503));
    await expect(
      callWithRetry(
        {
          budgetName: "imageGenerate",
          budget: { ...fast, retryIntervals: [10_000] },
          signal: ctrl.signal,
          logger,
        },
        fn,
      ),
    ).rejects.toMatchObject({
      name: "AbortError",
      code: "cancelled",
      message: "aborted while logging",
    });
    expect(fn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});
