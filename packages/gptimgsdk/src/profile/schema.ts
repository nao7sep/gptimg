import { z } from "zod";

/**
 * Profile format 2, a superset of format 1. Unknown fields are refused, so a
 * misspelled `apiKeyEnv` is an error rather than a silently ignored setting.
 * `policy` is checked only as an object here: each verb checks the sections it
 * uses where it uses them, so a broken `vision` section stops `vision` but not
 * `mask` (store-recovery-conventions).
 */
export const ProfileSchema = z
  .object({
    provider: z.literal("openai", { error: 'provider must be "openai"' }),
    apiKey: z.string().optional(),
    apiKeyEnv: z.string().min(1).optional(),
    organization: z.string().min(1).optional(),
    project: z.string().min(1).optional(),
    modelsDir: z.string().min(1).optional(),
    logDir: z.string().min(1).optional(),
    policy: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
