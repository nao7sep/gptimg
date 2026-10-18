import { policyError } from "../policy/schemas.ts";
import type { Policy } from "../types.ts";
import type { NetworkConfig } from "./defaults.ts";
import { resolveNetworkConfig } from "./resolve.ts";
import { NetworkSchema } from "./schema.ts";

export type { NetworkBudget, NetworkBudgetName, NetworkConfig } from "./defaults.ts";
export {
  NETWORK_BUDGET_NAMES,
  NETWORK_DEFAULTS,
} from "./defaults.ts";
export { callWithRetry } from "./retry.ts";
export { fetchWithBudget } from "./fetch.ts";

/**
 * Resolve the final NetworkConfig for a single call. `policy.network` is the
 * sole override path; code defaults fill in anything unspecified.
 */
export function resolveNetworkForCall(
  policy: Policy | undefined,
): NetworkConfig {
  const network = policy?.network;
  if (network === undefined) {
    return resolveNetworkConfig(undefined);
  }
  const r = NetworkSchema.safeParse(network);
  if (!r.success) throw policyError("network", r.error);
  return resolveNetworkConfig(r.data);
}
