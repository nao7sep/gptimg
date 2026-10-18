import { RecipeError } from "../errors.ts";
import type { Recipe } from "../types.ts";
import type { NetworkConfig } from "./defaults.ts";
import { formatZodError } from "../internal/zodError.ts";
import { resolveNetworkConfig } from "./resolve.ts";
import { NetworkSchema } from "./schema.ts";

export type { NetworkBudget, NetworkBudgetName, NetworkConfig } from "./defaults.ts";
export {
  NETWORK_BUDGET_NAMES,
  NETWORK_DEFAULTS,
} from "./defaults.ts";
export { callWithRetry, isAbortError } from "./retry.ts";
export { fetchWithBudget } from "./fetch.ts";

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
