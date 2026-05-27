export interface VerbCallOptions {
  /**
   * Abort the in-flight call cleanly. Cancels any pending OpenAI request,
   * URL download, retry sleep, and chroma phase boundary. Model work that
   * the server has already accepted will continue billing — we just stop
   * listening.
   */
  signal?: AbortSignal | undefined;
}
