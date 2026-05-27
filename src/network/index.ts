import { ProfileError, RecipeError } from "../errors.js";
import type { Logger } from "../log/index.js";
import type { Profile, Recipe } from "../types.js";
import type { NetworkConfig } from "./defaults.js";
import { resolveNetworkConfig } from "./resolve.js";
import { NetworkSchema, formatNetworkZodError } from "./schema.js";

export type { NetworkBudget, NetworkBudgetName, NetworkConfig } from "./defaults.js";
export {
  NETWORK_BUDGET_NAMES,
  NETWORK_DEFAULTS,
} from "./defaults.js";
export { callWithRetry, isAbortError } from "./retry.js";
export { fetchWithBudget } from "./fetch.js";

/**
 * Resolve the final NetworkConfig for a single call, layering code defaults
 * with profile-level and recipe-level overrides.
 */
export async function resolveNetworkForCall(
  profile: Profile,
  recipe: Recipe | undefined,
  _logger?: Logger,
): Promise<NetworkConfig> {
  const profileNetwork = profile.network;
  let parsedProfileNetwork: Parameters<typeof resolveNetworkConfig>[0];
  if (profileNetwork !== undefined) {
    const r = NetworkSchema.safeParse(profileNetwork);
    if (!r.success) {
      throw new ProfileError(
        "profile.invalid",
        `profile.network invalid: ${formatNetworkZodError(r.error)}`,
      );
    }
    parsedProfileNetwork = r.data;
  }

  const recipeNetwork = recipe?.network;
  let parsedRecipeNetwork: Parameters<typeof resolveNetworkConfig>[1];
  if (recipeNetwork !== undefined) {
    const r = NetworkSchema.safeParse(recipeNetwork);
    if (!r.success) {
      throw new RecipeError(
        "recipe.validationFailed",
        `recipe.network invalid: ${formatNetworkZodError(r.error)}`,
      );
    }
    parsedRecipeNetwork = r.data;
  }

  return resolveNetworkConfig(
    parsedProfileNetwork,
    parsedRecipeNetwork,
  );
}
