import {
  NETWORK_BUDGET_NAMES,
  NETWORK_DEFAULTS,
  type NetworkBudget,
  type NetworkConfig,
} from "./defaults.js";
import type { NetworkPartial } from "./schema.js";

function pickBudget(input: unknown): Partial<NetworkBudget> {
  if (!input || typeof input !== "object") return {};
  const p = input as Record<string, unknown>;
  const out: Partial<NetworkBudget> = {};
  if (typeof p.timeout === "number" && Number.isFinite(p.timeout) && p.timeout >= 0) {
    out.timeout = p.timeout;
  }
  if (
    typeof p.maxRetries === "number" &&
    Number.isFinite(p.maxRetries) &&
    p.maxRetries >= 0
  ) {
    out.maxRetries = p.maxRetries;
  }
  if (
    Array.isArray(p.retryIntervals) &&
    p.retryIntervals.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)
  ) {
    out.retryIntervals = [...(p.retryIntervals as number[])];
  }
  return out;
}

function mergeBudget(
  recipe: Partial<NetworkBudget>,
  profile: Partial<NetworkBudget>,
  defaults: NetworkBudget,
): NetworkBudget {
  return {
    timeout: recipe.timeout ?? profile.timeout ?? defaults.timeout,
    maxRetries: recipe.maxRetries ?? profile.maxRetries ?? defaults.maxRetries,
    retryIntervals:
      recipe.retryIntervals ?? profile.retryIntervals ?? defaults.retryIntervals,
  };
}

/**
 * Resolve the final network config by layering: code defaults < profile.network <
 * recipe.network. The last-defined value of each leaf wins (no array merging).
 */
export function resolveNetworkConfig(
  profileNetwork: NetworkPartial | undefined,
  recipeNetwork: NetworkPartial | undefined,
): NetworkConfig {
  const out = {} as NetworkConfig;
  for (const name of NETWORK_BUDGET_NAMES) {
    const recipeBudget = recipeNetwork ? pickBudget(recipeNetwork[name]) : {};
    const profileBudget = profileNetwork ? pickBudget(profileNetwork[name]) : {};
    out[name] = mergeBudget(recipeBudget, profileBudget, NETWORK_DEFAULTS[name]);
  }
  return out;
}
