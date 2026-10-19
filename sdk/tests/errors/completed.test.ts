import { describe, expect, it } from "vitest";
import { completed, isGptImgErrorData } from "../../src/index.ts";
import type { RefusedResult } from "../../src/index.ts";

type TrimLike = { status: "completed"; output: string; logPath: string | null } | RefusedResult;

describe("completed", () => {
  it("returns a completed result unchanged, narrowed to its completed type", () => {
    const result: TrimLike = { status: "completed", output: "/out.png", logPath: null };
    const narrowed = completed(result);
    expect(narrowed).toBe(result);
    expect(narrowed.output).toBe("/out.png");
  });

  it("throws a refusal as a GptImgError coded refused, keeping the refusal whole", () => {
    const refused: TrimLike = {
      status: "refused",
      refusal: { code: "output.exists", message: "Output exists: /out.png.", subject: "/out.png", safeReason: null },
      logPath: null,
    };
    let thrown: unknown;
    try {
      completed(refused);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({
      code: "refused",
      kind: "invalid",
      effect: "none",
      subject: "/out.png",
      message: "Output exists: /out.png.",
      details: { refusal: refused.refusal },
    });
    expect(isGptImgErrorData((thrown as { toJSON(): unknown }).toJSON())).toBe(true);
  });

  it("marks a refusal that came in a paid answer as having taken effect", () => {
    const refused: TrimLike = {
      status: "refused",
      refusal: { code: "provider.refused", message: "declined", safeReason: "no" },
      response: { usage: { prompt_tokens: 85 } },
      logPath: null,
    };
    expect(() => completed(refused)).toThrow(expect.objectContaining({ code: "refused", effect: "unknown" }));
  });
});
