import { GptImgError } from "./errors.ts";
import { assertAbsolutePath } from "./internal/absolute-path.ts";
import { defaultModelsDir } from "./internal/resource-home.ts";
import { validatePolicy } from "./policy/schemas.ts";
import { mergePolicies } from "./policy/merge.ts";
import { NO_LOG_HINT } from "./verbs/options.ts";
import type { Credentials } from "./providers/types.ts";
import type { GptImgOptions, Policy } from "./types.ts";

/** What one `GptImg` instance resolved from its options; in memory only. */
export interface SdkContext {
  apiKey: string | null;
  organization?: string;
  project?: string;
  baseURL?: string;
  modelsDir: string;
  /** Whether debug events reach `onEvent`. */
  debug: boolean;
  /** Whether this instance's startup event has been handed to a caller yet. */
  startup: { emitted: boolean };
  /** The instance's policy, checked whole. */
  policy: Policy;
  /** The calling app, recorded in sidecars beside the SDK's own name and version. */
  app?: { name: string; version: string };
}

// The constructor's options, so an unknown one is refused as a verb refuses an unknown argument;
// typed by GptImgOptions, so the list cannot miss or invent one.
const OPTIONS: Record<keyof GptImgOptions, true> = {
  apiKey: true,
  organization: true,
  project: true,
  baseURL: true,
  modelsDir: true,
  debug: true,
  policy: true,
  app: true,
};
const OPTION_NAMES: readonly string[] = Object.keys(OPTIONS);

// Options earlier versions took, with where their value now goes.
const RETIRED_OPTIONS: Record<string, string> = {
  profile: "profiles are retired; pass apiKey and the other settings here directly",
  profileDir: "there is no profile folder; pass modelsDir",
  logDir: NO_LOG_HINT,
};

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
 * Resolve an instance's context from the constructor's options, with the
 * SDK's default for the models folder only (consumer data has no default).
 * Touches no disk and reads nothing ambient.
 */
export function createContext(opts: GptImgOptions = {}): SdkContext {
  if (typeof opts !== "object" || opts === null) {
    throw new GptImgError("args.invalid", "GptImg options must be an object.", {
      details: { field: "options", constraint: "object" },
    });
  }
  const unknown = Object.keys(opts).find((key) => (opts as Record<string, unknown>)[key] !== undefined && !OPTION_NAMES.includes(key));
  if (unknown !== undefined) {
    throw new GptImgError("args.invalid", `GptImg: ${unknown} is not an option; ${RETIRED_OPTIONS[unknown] ?? `the options are ${OPTION_NAMES.join(", ")}`}.`, {
      details: { field: unknown, constraint: Object.hasOwn(RETIRED_OPTIONS, unknown) ? "retired" : "known option" },
    });
  }
  const apiKey = optionalString(opts.apiKey, "apiKey")?.trim();
  const organization = optionalString(opts.organization, "organization");
  const project = optionalString(opts.project, "project");
  const baseURL = optionalString(opts.baseURL, "baseURL")?.trim().replace(/\/+$/, "");
  if (baseURL !== undefined && !/^https?:\/\/[^\s/]+/.test(baseURL)) {
    throw new GptImgError("args.invalid", "baseURL must be an http or https URL.", { details: { field: "baseURL", constraint: "http(s) URL" } });
  }
  if (opts.modelsDir !== undefined) assertAbsolutePath(opts.modelsDir, "modelsDir");
  if (opts.debug !== undefined && typeof opts.debug !== "boolean") {
    throw new GptImgError("args.invalid", "debug must be a boolean.", { details: { field: "debug", constraint: "boolean" } });
  }
  const policy = opts.policy !== undefined ? validatePolicy(opts.policy) : {};
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
    apiKey: apiKey ?? null,
    ...(organization !== undefined && { organization }),
    ...(project !== undefined && { project }),
    ...(baseURL !== undefined && { baseURL }),
    modelsDir: opts.modelsDir ?? defaultModelsDir(),
    debug: opts.debug ?? false,
    startup: { emitted: false },
    policy,
    ...(app !== undefined && { app }),
  };
}

/** The credentials a paid call spends with, or `apiKey.missing` when none was given. */
export function requireCredentials(ctx: SdkContext): Credentials {
  if (!ctx.apiKey) {
    throw new GptImgError("apiKey.missing", "No API key: pass apiKey to the GptImg constructor.");
  }
  return {
    apiKey: ctx.apiKey,
    ...(ctx.organization !== undefined && { organization: ctx.organization }),
    ...(ctx.project !== undefined && { project: ctx.project }),
    ...(ctx.baseURL !== undefined && { baseURL: ctx.baseURL }),
  };
}

/**
 * The policy one call runs with: the call's over the instance's (last wins).
 * Each is checked once, the instance's when it was built and the call's here;
 * two checked policies merge into a checked one, since no rule spans fields.
 */
export function callPolicy(ctx: SdkContext, policy: Policy | undefined): Policy {
  if (policy === undefined) return ctx.policy;
  return mergePolicies(ctx.policy, validatePolicy(policy));
}

/** The models folder one call uses: its own, then the instance's. */
export function callModelsDir(ctx: SdkContext, modelsDir: string | undefined): string {
  if (modelsDir === undefined) return ctx.modelsDir;
  assertAbsolutePath(modelsDir, "modelsDir");
  return modelsDir;
}
