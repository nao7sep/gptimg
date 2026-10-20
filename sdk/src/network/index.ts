import type { Policy } from "../types.ts";
import type { NetworkConfig } from "./defaults.ts";
import { resolveNetworkConfig } from "./resolve.ts";

export type { NetworkBudget, NetworkBudgetName, NetworkConfig } from "./defaults.ts";
export {
  NETWORK_BUDGET_NAMES,
  NETWORK_DEFAULTS,
} from "./defaults.ts";
export { callWithRetry } from "./retry.ts";
export { fetchWithBudget } from "./fetch.ts";

/**
 * Resolve the final NetworkConfig for a single call from its checked policy
 * (`callPolicy`). `policy.network` is the sole override path; code defaults
 * fill in anything unspecified.
 */
export function resolveNetworkForCall(policy: Policy): NetworkConfig {
  return resolveNetworkConfig(policy.network);
}
