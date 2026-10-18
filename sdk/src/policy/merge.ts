import { createDefu } from "defu";
import type { Policy } from "../types.ts";

// "Last wins" for lists too: plain defu would join an override's list onto the
// policy's (`retryIntervals: [1]` over `[2, 3]` giving `[1, 2, 3]`).
const overrideDefu = createDefu((target, key, value) => {
  if (!Array.isArray(value)) return false;
  (target as Record<PropertyKey, unknown>)[key] = value;
  return true;
});

/**
 * Deep-merge policies. Later arguments win over earlier ones (the standard
 * "last wins" override semantics), and a list replaces the earlier list whole.
 * The base is supplied first; each patch overrides what came before.
 */
export function mergePolicies(base: Policy, ...patches: Partial<Policy>[]): Policy {
  let result: Policy = base;
  for (const patch of patches) {
    if (!patch) continue;
    result = overrideDefu(patch, result) as Policy;
  }
  return result;
}
