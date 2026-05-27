import { z } from "zod";

const NetworkBudgetSchema = z
  .object({
    timeout: z.number().int().nonnegative().optional(),
    maxRetries: z.number().int().min(0).optional(),
    retryIntervals: z.array(z.number().nonnegative()).optional(),
  })
  .passthrough();

export const NetworkSchema = z
  .object({
    imageGenerate: NetworkBudgetSchema.optional(),
    imageVision: NetworkBudgetSchema.optional(),
    imageDownload: NetworkBudgetSchema.optional(),
  })
  .passthrough();

export type NetworkPartial = z.infer<typeof NetworkSchema>;

export function formatNetworkZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
}
