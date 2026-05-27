import { ProfileError } from "../errors.js";
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

const LEGACY_PROFILE_KEYS = ["timeout", "maxRetries"] as const;

/**
 * Resolve the final NetworkConfig for a single call, layering code defaults
 * with profile-level and recipe-level overrides. Emits a deprecation warning
 * to the logger if the profile uses the legacy top-level `timeout` /
 * `maxRetries` fields.
 */
export async function resolveNetworkForCall(
  profile: Profile,
  recipe: Recipe | undefined,
  logger?: Logger,
): Promise<NetworkConfig> {
  const profileNetwork = profile.network;
  if (profileNetwork !== undefined) {
    const r = NetworkSchema.safeParse(profileNetwork);
    if (!r.success) {
      throw new ProfileError(
        "profile.invalid",
        `profile.network invalid: ${formatNetworkZodError(r.error)}`,
      );
    }
  }
  // Recipe-side validation already happens via RecipeSchema in loadRecipe
  // / mergeRecipes paths; recipe.network has been schema-checked at parse
  // time so we can read it directly here.
  const recipeNetwork = recipe?.network;

  if (logger) {
    const deprecated = LEGACY_PROFILE_KEYS.filter((k) => profile[k] !== undefined);
    if (deprecated.length > 0) {
      await logger.warn(
        "resolve",
        `profile uses deprecated top-level network field(s) — move under "network.imageGenerate" / "network.imageVision" / "network.imageDownload"`,
        { deprecated },
      );
    }
  }

  return resolveNetworkConfig(
    profileNetwork as Parameters<typeof resolveNetworkConfig>[0],
    recipeNetwork as Parameters<typeof resolveNetworkConfig>[1],
  );
}
