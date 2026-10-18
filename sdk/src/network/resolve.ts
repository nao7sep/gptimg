import { NETWORK_BUDGET_NAMES, NETWORK_DEFAULTS, type NetworkConfig } from "./defaults.ts";
import type { NetworkPartial } from "./schema.ts";

/**
 * The network config for a call: each budget's fields from the validated
 * `policy.network` where set, the code defaults elsewhere. A list replaces the
 * default list whole.
 */
export function resolveNetworkConfig(network: NetworkPartial | undefined): NetworkConfig {
  const out = {} as NetworkConfig;
  for (const name of NETWORK_BUDGET_NAMES) {
    const set = network?.[name];
    const defaults = NETWORK_DEFAULTS[name];
    out[name] = {
      timeout: set?.timeout ?? defaults.timeout,
      maxRetries: set?.maxRetries ?? defaults.maxRetries,
      retryIntervals: set?.retryIntervals ? [...set.retryIntervals] : defaults.retryIntervals,
    };
  }
  return out;
}
