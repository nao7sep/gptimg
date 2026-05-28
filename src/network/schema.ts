import { z } from "zod";

const NetworkBudgetSchema = z
  .object({
    timeout: z.number().int().nonnegative().optional(),
    maxRetries: z.number().int().min(0).optional(),
    retryIntervals: z.array(z.number().nonnegative()).optional(),
  })
  .strict();

export const NetworkSchema = z
  .object({
    imageGenerate: NetworkBudgetSchema.optional(),
    imageVision: NetworkBudgetSchema.optional(),
    imageDownload: NetworkBudgetSchema.optional(),
  })
  .strict();

export type NetworkPartial = z.infer<typeof NetworkSchema>;
