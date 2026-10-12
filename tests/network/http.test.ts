import { describe, expect, it } from "vitest";
import { combineSignals, HttpStatusError } from "../../src/network/http.js";

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

describe("HttpStatusError", () => {
  it("carries status and headers and names itself", () => {
    const headers = new Headers({ "retry-after": "1" });
    const err = new HttpStatusError(503, headers, "service unavailable");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("HttpStatusError");
    expect(err.status).toBe(503);
    expect(err.headers.get("retry-after")).toBe("1");
    // The retry layer reads `.status` to classify; assert it's a plain number.
    expect((err as { status?: unknown }).status).toBe(503);
  });

  it("ends a cut body excerpt in one marker", () => {
    const err = new HttpStatusError(500, new Headers(), "x".repeat(500));
    expect(err.message).toBe(`HTTP 500: ${"x".repeat(200)}...`);
  });

  it("shows a body that fits whole, on one line, with no marker", () => {
    const err = new HttpStatusError(502, new Headers(), "  bad\n  gateway  \n");
    expect(err.message).toBe("HTTP 502: bad gateway");
    const exact = new HttpStatusError(500, new Headers(), `${"x".repeat(200)}   \n`);
    expect(exact.message).toBe(`HTTP 500: ${"x".repeat(200)}`);
  });

  it("never splits a character at the cut", () => {
    const err = new HttpStatusError(500, new Headers(), "\u{1F600}".repeat(300));
    expect(err.message).toBe(`HTTP 500: ${"\u{1F600}".repeat(200)}...`);
  });

  it("omits the colon/body when the body is empty or blank", () => {
    expect(new HttpStatusError(404, new Headers(), "").message).toBe("HTTP 404");
    expect(new HttpStatusError(404, new Headers(), " \n ").message).toBe("HTTP 404");
  });
});

describe("combineSignals", () => {
  // No parent and no timeout (timeoutMs <= 0): a never-aborting signal.
  it("returns a never-firing signal with no parent and no timeout", () => {
    const sig = combineSignals(undefined, 0);
    expect(sig).toBeInstanceOf(AbortSignal);
    expect(sig.aborted).toBe(false);
  });

  // Only a parent (timeout disabled): returns that exact signal, untouched.
  it("returns the parent signal unchanged when no timeout is set", () => {
    const ctrl = new AbortController();
    const sig = combineSignals(ctrl.signal, 0);
    expect(sig).toBe(ctrl.signal);
    expect(sig.aborted).toBe(false);
    ctrl.abort(new Error("parent"));
    expect(sig.aborted).toBe(true);
  });

  // Only a timeout (no parent): a single timeout signal that fires on its own.
  it("fires the timeout when there is no parent", async () => {
    const sig = combineSignals(undefined, 5);
    expect(sig.aborted).toBe(false);
    await waitForAbort(sig);
    expect(sig.aborted).toBe(true);
    // AbortSignal.timeout aborts with a TimeoutError.
    expect((sig.reason as Error).name).toBe("TimeoutError");
  });

  // Both parent and timeout: AbortSignal.any — parent abort wins when it fires
  // first, with the parent's reason.
  it("aborts via the parent when both are present and the parent fires first", () => {
    const ctrl = new AbortController();
    const sig = combineSignals(ctrl.signal, 60_000);
    expect(sig.aborted).toBe(false);
    ctrl.abort(new Error("caller cancelled"));
    expect(sig.aborted).toBe(true);
    expect((sig.reason as Error).message).toBe("caller cancelled");
  });

  // Both present: the timeout wins when the parent never fires.
  it("aborts via the timeout when both are present and the parent stays open", async () => {
    const ctrl = new AbortController();
    const sig = combineSignals(ctrl.signal, 5);
    expect(sig.aborted).toBe(false);
    await waitForAbort(sig);
    expect(sig.aborted).toBe(true);
    expect((sig.reason as Error).name).toBe("TimeoutError");
  });
});
