import { z } from "zod";

/**
 * The sidecar's content, under its header, checked on read and on write
 * (store-recovery-conventions). It names the `operation` that paid for it.
 * The provider's response stays opaque but must be present; unrecognized keys
 * are kept as they are.
 */
const FileEntrySchema = z.looseObject({
  index: z.number().int(),
  name: z.string(),
  sha256: z.string(),
  format: z.string(),
});

export const SidecarSchema = z.discriminatedUnion("operation", [
  z.looseObject({
    operation: z.literal("generate"),
    request: z.looseObject({ prompt: z.string(), n: z.number().int().positive() }),
    response: z.record(z.string(), z.unknown()),
    files: z.array(FileEntrySchema).min(1),
  }),
  z.looseObject({
    operation: z.literal("edit"),
    request: z.looseObject({
      prompt: z.string(),
      n: z.number().int().positive(),
      input: z.string(),
      inputSha256: z.string(),
      mask: z.string().nullable(),
      maskSha256: z.string().nullable(),
    }),
    response: z.record(z.string(), z.unknown()),
    files: z.array(FileEntrySchema).min(1),
  }),
  z.looseObject({
    operation: z.literal("chat"),
    request: z.looseObject({
      model: z.string(),
      instructions: z.string().optional(),
      tool: z.record(z.string(), z.unknown()),
      message: z.string(),
      images: z.array(z.looseObject({ name: z.string(), sha256: z.string() })),
      previousResponseId: z.string().nullable(),
      historyTurns: z.number().int().nonnegative(),
    }),
    response: z.record(z.string(), z.unknown()),
    // A turn that produced no image still keeps its paid answer, as `<stem>.json`.
    files: z.array(FileEntrySchema),
  }),
  z.looseObject({
    operation: z.literal("vision"),
    request: z.looseObject({
      check: z.string(),
      inputs: z.array(z.looseObject({ name: z.string(), sha256: z.string() })).min(1),
    }),
    response: z.looseObject({
      verdict: z.looseObject({ ok: z.boolean(), score: z.number(), reasons: z.array(z.string()) }),
      raw: z.custom<unknown>((value) => value !== undefined, { message: "Required" }),
    }),
    files: z.array(FileEntrySchema).max(0),
  }),
]);
