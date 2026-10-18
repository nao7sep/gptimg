import { describe, expect, it } from "vitest";
import { combineSignals, HttpStatusError } from "../../src/network/http.ts";

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

  it("carries the complete body, exactly as received", () => {
    const body = `<html>\n  <body>${"x".repeat(5000)}\u{1F600}</body>\n</html>\n`;
    const err = new HttpStatusError(500, new Headers(), body);
    expect(err.message).toBe(`HTTP 500: ${body}`);
  });

  it("omits the colon/body when the body is empty", () => {
    const err = new HttpStatusError(404, new Headers(), "");
    expect(err.message).toBe("HTTP 404");
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
