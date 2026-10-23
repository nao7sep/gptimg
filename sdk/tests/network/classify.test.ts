// Provider and download failures named by their observed cause, with effect from
// the evidence (sdk-conventions, *Errors* and *Retries*), and the provider's
// documented reason for declining made safe to present.
import { describe, expect, it } from "vitest";
import { classifyRequestFailure, isQuotaExhausted, safeProviderReason, safeReasonText } from "../../src/network/classify.ts";
import { RefusalSignal } from "../../src/refusal.ts";

const KEY = "sk-hostile-0123456789";

function apiError(status: number, code?: string, message = "boom"): Error {
  return Object.assign(new Error(`${status} ${message}`), { status, code, error: { message, code }, requestID: "req_1" });
}

describe("classifyRequestFailure", () => {
  it.each([
    [400, undefined, "provider.rejected", "invalid", "none"],
    [401, "invalid_api_key", "provider.rejected", "invalid", "none"],
    [408, undefined, "provider.timeout", "unavailable", "none"],
    [429, "rate_limit_exceeded", "provider.rateLimited", "unavailable", "none"],
    [429, "insufficient_quota", "provider.quotaExhausted", "unavailable", "none"],
    [500, undefined, "provider.serverError", "unavailable", "unknown"],
    [503, undefined, "provider.serverError", "unavailable", "none"],
    [504, undefined, "provider.serverError", "unavailable", "unknown"],
  ] as const)("a paid %i (%s) is %s, %s, effect %s", (status, providerCode, code, kind, effect) => {
    expect(classifyRequestFailure(apiError(status, providerCode), "imageGenerate", "generate", [KEY])).toMatchObject({
      code,
      kind,
      effect,
      details: { status, requestId: "req_1", ...(providerCode !== undefined && { providerCode }) },
    });
  });

  it("knows an unreachable host spent nothing and a dropped or timed-out paid request may have", () => {
    const refused = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) });
    expect(classifyRequestFailure(refused, "imageVision", "vision", [])).toMatchObject({ code: "provider.unreachable", effect: "none" });
    const reset = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("x"), { code: "ECONNRESET" }) });
    expect(classifyRequestFailure(reset, "imageVision", "vision", [])).toMatchObject({ code: "provider.connectionLost", effect: "unknown" });
    class APIConnectionTimeoutError extends Error {}
    expect(classifyRequestFailure(new APIConnectionTimeoutError("Request timed out."), "imageGenerate", "g", [])).toMatchObject({
      code: "provider.timeout",
      effect: "unknown",
    });
    // A model download changes nothing remote.
    expect(classifyRequestFailure(apiError(500), "modelDownload", "download", [])).toMatchObject({ effect: "none" });
  });

  it("turns a moderation block into a refusal carrying only the documented reason, safely", () => {
    const err = apiError(400, "moderation_blocked", `Blocked for ${KEY}\u001b[31m\u202e\n\tsafety`);
    let thrown: unknown;
    try {
      classifyRequestFailure(err, "imageGenerate", "generate", [KEY]);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RefusalSignal);
    expect((thrown as RefusalSignal).refusal).toEqual({
      code: "provider.moderationBlocked",
      message: "generate was declined by the provider's moderation.",
      safeReason: "Blocked for [REDACTED] safety",
    });
  });

  it("masks the key in an error message it cannot classify", () => {
    const err = classifyRequestFailure(new Error(`odd ${KEY}`), "imageGenerate", "generate", [KEY]);
    expect(err).toMatchObject({ code: "internal.unexpected", effect: "unknown" });
    expect(err.message).not.toContain(KEY);
  });

  it("tells an exhausted quota from a rate limit", () => {
    expect(isQuotaExhausted(apiError(429, "insufficient_quota"))).toBe(true);
    expect(isQuotaExhausted(apiError(429, "rate_limit_exceeded"))).toBe(false);
  });
});

describe("safe reasons", () => {
  it("strips control, bidi and escape sequences, collapses whitespace and masks credentials", () => {
    expect(safeReasonText(`  I can’t ${KEY}\u0007\u001b[2J\u2066x\u2069  \r\n verify. `, [KEY])).toBe("I can’t [REDACTED] x verify.");
    expect(safeReasonText("\u0000\u001f   ", [])).toBeNull();
  });

  it("reads only the error body's message field, never the raw body", () => {
    expect(safeProviderReason({ error: { message: "Declined." }, body: "<html>raw</html>" }, [])).toBe("Declined.");
    expect(safeProviderReason({ body: "Declined." }, [])).toBeNull();
  });
});
