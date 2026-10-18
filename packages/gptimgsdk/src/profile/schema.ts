import { z } from "zod";

export const ProfileSchema = z
  .object({
    provider: z.string().min(1),
    apiKey: z.string().optional(),
    apiKeyEnv: z.string().optional(),
    organization: z.string().optional(),
    project: z.string().optional(),
  })
  .strict();
