import type { LogEntry } from "../types.js";

export interface VerbCallOptions {
  /**
   * Abort the in-flight call cleanly. Cancels any pending OpenAI request,
   * URL download, retry sleep, and chroma phase boundary. Model work that
   * the server has already accepted will continue billing — we just stop
   * listening.
   */
  signal?: AbortSignal | undefined;

  /**
   * Receive progress as the operation runs. The SDK calls this with each
   * info/warn stage event it would otherwise only write to the log file; it
   * never writes to a stream itself. With no callback the SDK stays silent.
   * The CLI supplies a callback that renders one line per event to stderr.
   */
  onProgress?: ((entry: LogEntry) => void) | undefined;
}
