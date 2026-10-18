import { describe, expect, it } from "vitest";
import { AbortError, LocalOpError } from "../../src/errors.ts";
import { containOutOfMemory, isOutOfMemory } from "../../src/internal/out-of-memory.ts";

/** The RangeError V8 itself throws for an allocation it refuses. */
function v8Refusal(allocate: () => unknown): RangeError {
  try {
    allocate();
  } catch (err) {
    return err as RangeError;
  }
  throw new Error("allocation unexpectedly succeeded");
}

describe("isOutOfMemory", () => {
  it("recognizes V8's own refusals of a typed array or ArrayBuffer", () => {
    expect(isOutOfMemory(v8Refusal(() => new Uint8Array(2 ** 53)))).toBe(true);
    expect(isOutOfMemory(v8Refusal(() => new ArrayBuffer(Number.MAX_SAFE_INTEGER)))).toBe(true);
  });

  it("recognizes native allocation failures through a typed error's cause chain", () => {
    for (const native of ["std::bad_alloc", "bad allocation", "Failed to allocate memory for requested buffer of size 123", "vips: out of memory"]) {
      const wrapped = new LocalOpError("model.runFailed", `ONNX inference failed: ${native}`, { cause: new Error(native) });
      expect(isOutOfMemory(new LocalOpError("image.writeFailed", "upscale: failed", { cause: wrapped })), native).toBe(true);
    }
  });

  it("leaves cancellation and unrelated failures alone", () => {
    expect(isOutOfMemory(new AbortError("cancelled", { cause: new RangeError("Array buffer allocation failed") }))).toBe(false);
    expect(isOutOfMemory(new RangeError("Maximum call stack size exceeded"))).toBe(false);
    expect(isOutOfMemory(new LocalOpError("image.sizeMismatch", "mask size 2x2 does not match image 3x3."))).toBe(false);
    expect(isOutOfMemory("out of memory")).toBe(false);
  });

  it("terminates on a cyclic cause chain", () => {
    const a = new Error("first");
    const b = new Error("second", { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(isOutOfMemory(a)).toBe(false);
  });
});

describe("containOutOfMemory", () => {
  it("reports an allocation failure as memory.exhausted with the verb's advice and the original cause", () => {
    const cause = v8Refusal(() => new Uint8Array(2 ** 53));
    const upscale = containOutOfMemory("upscale", cause) as LocalOpError;
    expect(upscale).toBeInstanceOf(LocalOpError);
    expect(upscale.code).toBe("memory.exhausted");
    expect(upscale.message).toMatch(/^upscale ran out of memory \(.+\)\. Pass a smaller tile/);
    expect(upscale.cause).toBe(cause);

    expect((containOutOfMemory("mask", cause) as Error).message).toContain('use method "chroma"');
    expect((containOutOfMemory("shadow", cause) as Error).message).toContain("Use smaller images or output sizes");
  });

  it("returns other errors, and an already contained one, unchanged", () => {
    const other = new LocalOpError("image.readFailed", "missing");
    expect(containOutOfMemory("resize", other)).toBe(other);
    const contained = containOutOfMemory("resize", new RangeError("Array buffer allocation failed"));
    expect(containOutOfMemory("resize", contained)).toBe(contained);
  });
});
