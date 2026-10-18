import { z } from "zod";

// The longest wait a Node timer can hold; a longer timeout would fire at once.
export const MAX_TIMEOUT_MS = 2_147_000_000;

const NetworkBudgetSchema = z
  .object({
    timeout: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
    maxRetries: z.number().int().min(0).optional(),
    retryIntervals: z.array(z.number().nonnegative()).optional(),
  })
  .strict();

export const NetworkSchema = z
  .object({
    imageGenerate: NetworkBudgetSchema.optional(),
    imageVision: NetworkBudgetSchema.optional(),
    imageDownload: NetworkBudgetSchema.optional(),
    modelDownload: NetworkBudgetSchema.optional(),
  })
  .strict();

export type NetworkPartial = z.infer<typeof NetworkSchema>;
