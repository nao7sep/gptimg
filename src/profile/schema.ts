import { z } from "zod";
import { NetworkSchema } from "../network/schema.js";

export const ProfileSchema = z
  .object({
    provider: z.string().min(1),
    apiKey: z.string().optional(),
    apiKeyEnv: z.string().optional(),
    organization: z.string().optional(),
    project: z.string().optional(),
    network: NetworkSchema.optional(),
  })
  .strict();

export type ProfileSchemaType = z.infer<typeof ProfileSchema>;

export function formatProfileZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
}
