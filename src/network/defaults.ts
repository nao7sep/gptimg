export interface NetworkBudget {
  /** Per-attempt timeout in ms. `0` disables the timeout (use with caution). */
  timeout: number;
  /** Maximum number of retries after the initial attempt. `0` disables retries. */
  maxRetries: number;
  /**
   * Schedule of waits between retries, in ms. `retryIntervals[N-1]` is the
   * wait before retry N. If `retryIntervals.length < maxRetries`, the last
   * value is reused for every subsequent retry. `[]` means immediate retry.
   *
   * `Retry-After` / `retry-after-ms` headers, when present, override this
   * schedule for the corresponding attempt.
   */
  retryIntervals: number[];
}

export type NetworkBudgetName =
  | "imageGenerate"
  | "imageVision"
  | "imageDownload"
  | "modelDownload";

export const NETWORK_BUDGET_NAMES: readonly NetworkBudgetName[] = [
  "imageGenerate",
  "imageVision",
  "imageDownload",
  "modelDownload",
];

export const NETWORK_DEFAULTS: Record<NetworkBudgetName, NetworkBudget> = {
  imageGenerate: { timeout: 600_000, maxRetries: 2, retryIntervals: [2_000, 5_000] },
  imageVision:   { timeout: 120_000, maxRetries: 2, retryIntervals: [2_000, 5_000] },
  imageDownload: { timeout:  30_000, maxRetries: 2, retryIntervals: [  500, 1_500] },
  // Large one-shot file (the BiRefNet weights are ~490 MB). `timeout` is the
  // per-attempt ceiling for the whole streamed download, generous enough for a
  // slow link but finite so a stalled connection retries instead of hanging.
  modelDownload: { timeout: 600_000, maxRetries: 2, retryIntervals: [2_000, 5_000] },
};

export interface NetworkConfig {
  imageGenerate: NetworkBudget;
  imageVision: NetworkBudget;
  imageDownload: NetworkBudget;
  modelDownload: NetworkBudget;
}
