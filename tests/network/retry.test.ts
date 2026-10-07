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
        { budgetName: "imageDownload", budget: fast },
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
    vi.useFakeTimers();
    const ctrl = new AbortController();
    const fn = vi.fn().mockRejectedValue(http(503));
    const operation = callWithRetry(
      {
        budgetName: "imageGenerate",
        budget: { ...fast, retryIntervals: [50] },
        signal: ctrl.signal,
      },
      fn,
    );
    const rejected = expect(operation).rejects.toMatchObject({
      name: "AbortError",
      code: "cancelled",
      message: "stop sleeping",
    });
    void rejected.catch(() => undefined);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fn).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(1);
      ctrl.abort(new Error("stop sleeping"));
      await rejected;
      expect(fn).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      ctrl.abort();
      await operation.catch(() => undefined);
      vi.useRealTimers();
    }
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

  it("caps an untrusted Retry-After value to the configured timeout", async () => {
    vi.useFakeTimers();
    try {
      const logger = fakeLogger();
      const headers = new Headers({ "retry-after": "9999" });
      const fn = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error("429"), { status: 429, headers }))
        .mockResolvedValueOnce("ok");
      const pending = callWithRetry(
        {
          budgetName: "imageGenerate",
          budget: { ...fast, timeout: 25, maxRetries: 1 },
          logger,
        },
        fn,
      );
      await vi.advanceTimersByTimeAsync(25);
      await expect(pending).resolves.toBe("ok");
      expect(logger.warn.mock.calls[0]?.[2]).toMatchObject({
        waitMs: 25,
        retryAfterHeader: true,
        retryAfterCapped: true,
      });
    } finally {
      vi.useRealTimers();
    }
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
        { budgetName: "imageDownload", budget: fast },
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
      status: 429,
      error: { name: "Error", message: "429", code: null },
      retryAfterHeader: true,
    });
    expect(data).not.toHaveProperty("request");
  });

  // With no status, the error's name, message and network code say what failed.
  it("logs the error when there is no status", async () => {
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
    expect(data).toMatchObject({
      status: null,
      error: { name: "Error", code: "ECONNRESET" },
      retryAfterHeader: false,
    });
  });

  it("records each failed attempt with its request, the last one before rethrowing", async () => {
    const logger = fakeLogger();
    const request = { model: "m", prompt: "p" };
    const final = http(400);
    const fn = vi.fn().mockRejectedValueOnce(http(429)).mockRejectedValueOnce(final);
    await expect(
      callWithRetry({ budgetName: "imageGenerate", budget: fast, logger, request }, fn),
    ).rejects.toBe(final);
    expect(logger.warn.mock.calls.map(([stage, , data]) => [stage, data.attempt, data.status, data.request])).toEqual([
      ["retry", 1, 429, request],
      ["response", 2, 400, request],
    ]);
    expect(logger.warn.mock.calls[1]?.[1]).toBe("imageGenerate attempt 2 failed");
  });

  it("records the last attempt once the retries run out", async () => {
    const logger = fakeLogger();
    const fn = vi.fn().mockRejectedValue(http(503));
    await expect(
      callWithRetry({ budgetName: "imageGenerate", budget: fast, logger }, fn),
    ).rejects.toMatchObject({ status: 503 });
    const stages = logger.warn.mock.calls.map(([stage]) => stage);
    expect(stages).toEqual([...Array(fast.maxRetries).fill("retry"), "response"]);
  });

  it("records a successful attempt that names its response, after a retried one, and returns the result", async () => {
    const info = vi.fn(async () => {});
    const logger = { ...fakeLogger(), info } as unknown as Logger;
    const request = { model: "m" };
    const fn = vi.fn().mockRejectedValueOnce(http(429)).mockResolvedValueOnce({ body: "ok", bytes: "x" });

    const result = await callWithRetry(
      { budgetName: "imageGenerate", budget: fast, logger, request, response: (r: { body: string }) => r.body },
      fn,
    );

    expect(result).toEqual({ body: "ok", bytes: "x" });
    expect(info.mock.calls).toEqual([
      [
        "response",
        "imageGenerate attempt 2 succeeded",
        { budget: "imageGenerate", attempt: 2, maxRetries: fast.maxRetries, durationMs: expect.any(Number), request, outcome: "succeeded", response: "ok" },
      ],
    ]);
  });

  it("logs no success line for a call that records no response", async () => {
    const info = vi.fn(async () => {});
    const logger = { ...fakeLogger(), info } as unknown as Logger;
    await callWithRetry({ budgetName: "imageDownload", budget: fast, logger, request: { url: "u" } }, async () => "bytes");
    expect(info).not.toHaveBeenCalled();
  });

  it("records a cancelled attempt with its request and the cancelled outcome", async () => {
    const info = vi.fn(async () => {});
    const logger = { ...fakeLogger(), info } as unknown as Logger;
    const ctrl = new AbortController();
    const request = { model: "m", prompt: "p" };
    const fn = vi.fn(async () => {
      ctrl.abort(new Error("stop"));
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    await expect(
      callWithRetry({ budgetName: "imageGenerate", budget: fast, signal: ctrl.signal, logger, request }, fn),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(info.mock.calls).toEqual([
      [
        "cancelled",
        "imageGenerate attempt 1 cancelled",
        { budget: "imageGenerate", attempt: 1, maxRetries: fast.maxRetries, durationMs: expect.any(Number), request, outcome: "cancelled" },
      ],
    ]);
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

// A paid provider call may have been processed and billed even when the client
// sees a timeout, a dropped connection or a gateway error, so those are never
// resent. Only failures proving the provider never started the work are.
describe("callWithRetry on a paid budget", () => {
  const paid = ["imageGenerate", "imageVision"] as const;

  it("does NOT resend after a timeout, a dropped connection or a gateway error", async () => {
    const maybeProcessed = [
      named("TimeoutError"),
      named("APIConnectionTimeoutError"),
      named("APIConnectionError"),
      netCode("ECONNRESET"),
      netCode("ETIMEDOUT"),
      netCode("EPIPE"),
      http(500),
      http(502),
      http(504),
      http(520),
      http(524),
    ];
    for (const budgetName of paid) {
      for (const err of maybeProcessed) {
        const fn = vi.fn().mockRejectedValue(err);
        await expect(
          callWithRetry({ budgetName, budget: fast }, fn),
        ).rejects.toBe(err);
        expect(fn, `${budgetName} ${err.message}`).toHaveBeenCalledOnce();
      }
    }
  });

  it("resends a 408, 429 or 503 rejection", async () => {
    for (const budgetName of paid) {
      for (const status of [408, 429, 503]) {
        const fn = vi
          .fn()
          .mockRejectedValueOnce(http(status))
          .mockResolvedValueOnce("ok");
        await expect(callWithRetry({ budgetName, budget: fast }, fn)).resolves.toBe("ok");
        expect(fn, `${budgetName} ${status}`).toHaveBeenCalledTimes(2);
      }
    }
  });

  it("resends a connection that was refused or never resolved, read through the SDK's cause chain", async () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]) {
      // APIConnectionError -> TypeError("fetch failed") -> system error with code.
      const wrapped = Object.assign(named("APIConnectionError"), {
        cause: Object.assign(new TypeError("fetch failed"), { cause: netCode(code) }),
      });
      const fn = vi.fn().mockRejectedValueOnce(wrapped).mockResolvedValueOnce("ok");
      await expect(
        callWithRetry({ budgetName: "imageGenerate", budget: fast }, fn),
      ).resolves.toBe("ok");
      expect(fn, code).toHaveBeenCalledTimes(2);
    }
  });

  it("does NOT resend an SDK connection error whose cause is a mid-request reset", async () => {
    const wrapped = Object.assign(named("APIConnectionError"), {
      cause: Object.assign(new TypeError("fetch failed"), { cause: netCode("ECONNRESET") }),
    });
    const fn = vi.fn().mockRejectedValue(wrapped);
    await expect(
      callWithRetry({ budgetName: "imageGenerate", budget: fast }, fn),
    ).rejects.toBe(wrapped);
    expect(fn).toHaveBeenCalledOnce();
  });
});
