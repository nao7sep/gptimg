import { readFileSync } from "node:fs";
import { ERROR_CODES, REFUSAL_CODES, type ErrorCode, type GptImgErrorData } from "gptimgsdk/types";
import { describe, expect, it } from "vitest";
import { failureFromError, failureFromRefusal } from "../../src/shared/failures.ts";

const english = JSON.parse(readFileSync(new URL("../../src/shared/i18n/catalogues/en.json", import.meta.url), "utf8")) as Record<string, string>;
const HOSTILE = "<img src=x onerror=alert(1)> sk-proj-SECRET";

describe("SDK failures in the app's words", () => {
  it("gives every SDK error code catalogue text, never the SDK's message", () => {
    for (const code of Object.keys(ERROR_CODES) as ErrorCode[]) {
      const data: GptImgErrorData = { name: "GptImgError", code, kind: ERROR_CODES[code], effect: "none", message: HOSTILE };
      const failure = failureFromError(data);
      expect(english[failure.message.key], code).toBeDefined();
      expect(JSON.stringify(failure)).not.toContain("SECRET");
    }
  });

  it("gives every refusal code catalogue text and keeps the provider's safe reason apart", () => {
    for (const code of REFUSAL_CODES) {
      const failure = failureFromRefusal({ code, message: HOSTILE, safeReason: "Declined." });
      expect(english[failure.message.key], code).toBeDefined();
      expect(failure.reason).toBe("Declined.");
      expect(failure.retryable).toBe(false);
    }
  });

  it("names the key when OpenAI refuses it", () => {
    const failure = failureFromError({ name: "GptImgError", code: "provider.rejected", kind: "invalid", effect: "none", message: HOSTILE, details: { status: 401 } });
    expect(failure).toEqual({ message: { key: "failure.keyRejected" }, retryable: false });
  });

  it("unwraps a refusal a script turned into an error", () => {
    const failure = failureFromError({
      name: "GptImgError",
      code: "refused",
      kind: "invalid",
      effect: "none",
      message: HOSTILE,
      details: { refusal: { code: "provider.contentFiltered", message: HOSTILE, safeReason: null } },
    });
    expect(failure.message.key).toBe("failure.contentFiltered");
  });
});
