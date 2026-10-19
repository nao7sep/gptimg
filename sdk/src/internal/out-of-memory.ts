import { GptImgError } from "../errors.ts";
import type { VerbName } from "../types.ts";

/**
 * Out-of-memory containment (volume-handling-conventions). No verb checks free
 * memory before it starts; an allocation that still fails is recognized here,
 * at the verb boundary, and reported as `memory.exhausted` with what to change.
 * Every verb publishes its output only at the end, so the failure leaves no
 * partial file. A runtime the OS kills outright cannot be contained here.
 *
 * Recognized failures: V8 refusing a typed array or ArrayBuffer, and native
 * allocators (ONNX Runtime's `std::bad_alloc` or allocation errors, libvips's
 * "out of memory") reached through a typed error's `cause` chain.
 */
const JS_ALLOCATION = /array buffer allocation failed|invalid (typed )?array( buffer)? length/i;
const NATIVE_ALLOCATION = /bad[_ ]alloc|bad allocation|failed to allocate|out of memory/i;

export function isOutOfMemory(err: unknown): boolean {
  const seen = new Set<unknown>();
  for (let e = err; e instanceof Error && !seen.has(e); e = e.cause) {
    seen.add(e);
    if (e instanceof GptImgError && e.code === "cancelled") return false;
    if (e instanceof GptImgError && e.code === "memory.exhausted") return true;
    if (e instanceof RangeError && JS_ALLOCATION.test(e.message)) return true;
    if (NATIVE_ALLOCATION.test(e.message)) return true;
  }
  return false;
}

const ADVICE: Partial<Record<VerbName, string>> = {
  upscale: "Pass a smaller tile, upscale a smaller image, or close other apps and retry.",
  mask: 'The AI method needs far more memory than "chroma"; close other apps and retry, or use method "chroma".',
};
const GENERAL_ADVICE = "Use smaller images or output sizes, or close other apps and retry.";

/** `err` as `memory.exhausted` when it is an allocation failure; otherwise unchanged. */
export function containOutOfMemory(verb: VerbName, err: unknown): unknown {
  if (!isOutOfMemory(err)) return err;
  if (err instanceof GptImgError && err.code === "memory.exhausted") return err;
  const reason = err instanceof Error ? err.message : String(err);
  // The effect a typed failure already established stands (a paid response
  // that arrived, a write that began); a bare allocation failure changed nothing.
  const effect = err instanceof GptImgError ? err.effect : "none";
  return new GptImgError(
    "memory.exhausted",
    `${verb} ran out of memory (${reason}). ${ADVICE[verb] ?? GENERAL_ADVICE}`,
    { cause: err, effect },
  );
}
