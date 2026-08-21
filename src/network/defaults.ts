export interface NetworkBudget {
  /** Positive per-attempt timeout in ms. */
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
  // Large one-shot file (the BiRefNet weights are ~490 MB). For model downloads,
  // `timeout` bounds an idle network edge; the acquisition layer adds a separate
  // size-scaled deadline around the complete transaction.
  modelDownload: { timeout: 600_000, maxRetries: 2, retryIntervals: [2_000, 5_000] },
};

export interface NetworkConfig {
  imageGenerate: NetworkBudget;
  imageVision: NetworkBudget;
  imageDownload: NetworkBudget;
  modelDownload: NetworkBudget;
}
