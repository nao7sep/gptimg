import type { PartialImage, ProgressUpdate, SdkEvent } from "../types.ts";

/** Where a retired log option's value now goes, for the refusal that names it. */
export const NO_LOG_HINT = "the SDK writes no log; store the events onEvent receives";

export interface VerbCallOptions {
  /**
   * Stop the call at its next safe boundary with a `cancelled` error whose
   * `effect` says whether anything had already taken effect. Work a provider
   * has already accepted may still be billed; the SDK stops listening and
   * leaves no unfinished output that looks complete.
   */
  signal?: AbortSignal | undefined;

  /**
   * Receive every event of the call as it happens: a complete record (time,
   * level, stage, verb, event name, typed fields, message), credentials
   * masked. The SDK writes no log; this is its record of the call, for the
   * caller to store with its own. Debug events arrive only when the instance
   * was built with `debug: true`. A throwing or rejecting hook never affects
   * the call.
   */
  onEvent?: ((event: SdkEvent) => void) | undefined;

  /**
   * Receive counts of countable work (download and hash bytes, upscale tiles,
   * grid inputs, icon renditions, feather passes), at most every 100 ms plus
   * the final count.
   */
  onProgress?: ((update: ProgressUpdate) => void) | undefined;

  /**
   * Receive each draft of an image while it is drawn, when the call's policy
   * asks for partial images (`chat.partial_images`). A throwing hook never
   * affects the call.
   */
  onPartialImage?: ((image: PartialImage) => void) | undefined;
}
