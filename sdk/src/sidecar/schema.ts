import { z } from "zod";

/**
 * Sidecar shapes, checked on read and on write (store-recovery-conventions).
 * Format 1 (and unmarked v0.1.0 files) is one loose shape for every record;
 * its kind is told apart by shape. Format 2 names its `kind` and its `writer`.
 * The provider's response stays opaque but must be present; unrecognized keys
 * are kept as they are.
 */
const FileEntrySchema = z.looseObject({
  index: z.number().int(),
  name: z.string(),
  sha256: z.string(),
  format: z.string(),
});

export const SidecarV1Schema = z.looseObject({
  request: z.record(z.string(), z.unknown()),
  response: z.custom<unknown>((value) => value !== undefined, { message: "Required" }),
  files: z.array(FileEntrySchema),
});

const WriterSchema = z.looseObject({
  name: z.literal("gptimgsdk"),
  version: z.string().min(1),
  app: z.looseObject({ name: z.string().min(1), version: z.string().min(1) }).optional(),
});

export const SidecarV2Schema = z.discriminatedUnion("kind", [
  z.looseObject({
    kind: z.literal("generate"),
    writer: WriterSchema,
    request: z.looseObject({ prompt: z.string(), n: z.number().int().positive() }),
    response: z.record(z.string(), z.unknown()),
    files: z.array(FileEntrySchema).min(1),
  }),
  z.looseObject({
    kind: z.literal("edit"),
    writer: WriterSchema,
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
    kind: z.literal("chat"),
    writer: WriterSchema,
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
    kind: z.literal("vision"),
    writer: WriterSchema,
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
