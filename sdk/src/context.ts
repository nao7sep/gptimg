import { GptImgError } from "./errors.ts";
import { assertAbsolutePath } from "./internal/absolute-path.ts";
import { defaultModelsDir } from "./internal/resource-home.ts";
import { mergePolicies } from "./policy/merge.ts";
import type { GptImgOptions, Policy, ResolvedProfile } from "./types.ts";

/** What one `GptImg` instance resolved from its options and profile; in memory only. */
export interface SdkContext {
  apiKey: string | null;
  apiKeySource: string | null;
  organization?: string;
  project?: string;
  modelsDir: string;
  logDir: string | null;
  /** The profile's policy with the instance's merged over it. */
  policy: Policy;
  /** The calling app, recorded in sidecars beside the SDK's own name and version. */
  app?: { name: string; version: string };
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GptImgError("args.invalid", `${field} must be a non-empty string.`, {
      details: { field, constraint: "non-empty string" },
    });
  }
  return value;
}

/**
 * Resolve an instance's context. Precedence per value: the constructor's
 * option, then the profile, then the SDK's default (for the models folder
 * only; consumer data has no default). Touches no disk and reads nothing
 * ambient.
 */
export function createContext(opts: GptImgOptions = {}): SdkContext {
  if (typeof opts !== "object" || opts === null) {
    throw new GptImgError("args.invalid", "GptImg options must be an object.", {
      details: { field: "options", constraint: "object" },
    });
  }
  const profile = opts.profile;
  const apiKey = optionalString(opts.apiKey, "apiKey")?.trim();
  const organization = optionalString(opts.organization, "organization") ?? profile?.organization;
  const project = optionalString(opts.project, "project") ?? profile?.project;
  if (opts.modelsDir !== undefined) assertAbsolutePath(opts.modelsDir, "modelsDir");
  if (opts.logDir !== undefined) assertAbsolutePath(opts.logDir, "logDir");
  let app: SdkContext["app"];
  if (opts.app !== undefined) {
    const name = optionalString(opts.app?.name, "app.name");
    const version = optionalString(opts.app?.version, "app.version");
    if (name === undefined || version === undefined) {
      throw new GptImgError("args.invalid", "app needs both name and version.", {
        details: { field: "app", constraint: "name and version" },
      });
    }
    app = { name, version };
  }
  return {
    apiKey: apiKey ?? profile?.apiKey ?? null,
    apiKeySource: apiKey ? "constructor" : (profile?.apiKeySource ?? null),
    ...(organization !== undefined && { organization }),
    ...(project !== undefined && { project }),
    modelsDir: opts.modelsDir ?? profile?.modelsDir ?? defaultModelsDir(),
    logDir: opts.logDir ?? profile?.logDir ?? null,
    policy: mergePolicies(profile?.policy ?? {}, opts.policy ?? {}),
    ...(app !== undefined && { app }),
  };
}

/** The credentials a paid call spends with, or `apiKey.missing` when none was given. */
export function requireCredentials(ctx: SdkContext): ResolvedProfile {
  if (!ctx.apiKey) {
    throw new GptImgError(
      "apiKey.missing",
      "No API key: pass apiKey to the GptImg constructor, or a profile that stores one or names its variable in apiKeyEnv with the environment passed to loadProfile.",
    );
  }
  return {
    redacted: {
      provider: "openai",
      ...(ctx.organization !== undefined && { organization: ctx.organization }),
      ...(ctx.project !== undefined && { project: ctx.project }),
    },
    apiKey: ctx.apiKey,
    apiKeySource: ctx.apiKeySource ?? "constructor",
  };
}

/** The policy one call runs with: the call's over the instance's (last wins). */
export function callPolicy(ctx: SdkContext, policy: Policy | undefined): Policy {
  return policy === undefined ? ctx.policy : mergePolicies(ctx.policy, policy);
}

/** The models folder one call uses: its own, then the instance's. */
export function callModelsDir(ctx: SdkContext, modelsDir: string | undefined): string {
  if (modelsDir === undefined) return ctx.modelsDir;
  assertAbsolutePath(modelsDir, "modelsDir");
  return modelsDir;
}
