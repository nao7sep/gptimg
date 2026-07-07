import { RecipeError } from "../errors.js";
import type { Recipe } from "../types.js";
import type { NetworkConfig } from "./defaults.js";
import { formatZodError } from "../internal/zodError.js";
import { resolveNetworkConfig } from "./resolve.js";
import { NetworkSchema } from "./schema.js";

export type { NetworkBudget, NetworkBudgetName, NetworkConfig } from "./defaults.js";
export {
  NETWORK_BUDGET_NAMES,
  NETWORK_DEFAULTS,
} from "./defaults.js";
export { callWithRetry, isAbortError } from "./retry.js";
export { fetchWithBudget } from "./fetch.js";

/**
 * Resolve the final NetworkConfig for a single call. recipe.network is the
 * sole override path; code defaults fill in anything unspecified.
 */
export function resolveNetworkForCall(
  recipe: Recipe | undefined,
): NetworkConfig {
  const recipeNetwork = recipe?.network;
  if (recipeNetwork === undefined) {
    return resolveNetworkConfig(undefined);
  }
  const r = NetworkSchema.safeParse(recipeNetwork);
  if (!r.success) {
    throw new RecipeError(
      "recipe.validationFailed",
      `recipe.network invalid: ${formatZodError(r.error)}`,
    );
  }
  return resolveNetworkConfig(r.data);
}
