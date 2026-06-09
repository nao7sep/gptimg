import { describe, expect, it, vi } from "vitest";
import { AbortError } from "../../src/errors.js";
import { callWithRetry, isAbortError } from "../../src/network/retry.js";
import type { NetworkBudget } from "../../src/network/defaults.js";

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
});
