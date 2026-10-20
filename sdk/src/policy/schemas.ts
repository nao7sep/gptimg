import { z } from "zod";
import { HEX_RE } from "../color.ts";
import { VISION_DETAILS } from "../enums.ts";
import { GptImgError } from "../errors.ts";
import { firstZodIssue, formatZodError } from "../internal/zodError.ts";
import { NetworkSchema } from "../network/schema.ts";
import type { Policy } from "../types.ts";

// A supported model's values are checked against its row before the call; here only their
// types are. Moderation is not a choice: generate sends "low" for a supported model, so neither
// section takes it.
const IMAGE_PARAMS_SHAPE = {
  model: z.string().optional(),
  size: z.string().optional(),
  quality: z.string().optional(),
  background: z.string().optional(),
  output_format: z.string().optional(),
  output_compression: z.number().optional(),
  n: z.number().int().positive().optional(),
  moderation: z
    .never({ error: 'moderation is not a policy field; generate sends moderation "low" for a supported model' })
    .optional(),
};

// Strict, like every section: a request is built from these fields, so a misspelt one would be
// sent to OpenAI and paid for, or silently fall back to a default.
const GeneratePolicySchema = z.object(IMAGE_PARAMS_SHAPE).strict();

const EditPolicySchema = z.object(IMAGE_PARAMS_SHAPE).strict();

const VisionShrinkSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

const VisionPolicySchema = z
  .object({
    model: z.string().optional(),
    shrink: VisionShrinkSchema.optional(),
    detail: z.enum(VISION_DETAILS).optional(),
    reasoning: z.string().optional(),
    // The effort is sent from `reasoning`, so a passed-through wire field would be overwritten.
    reasoning_effort: z
      .never({ error: "reasoning_effort is not a policy field; set reasoning, which gptimg sends as reasoning_effort" })
      .optional(),
    systemPrompt: z.string().optional(),
  })
  .strict();

const ChromaPolicySchema = z
  .object({
    color: z.string().regex(HEX_RE, "Must be a #rrggbb hex color").optional(),
    preserveInterior: z.boolean().optional(),
    borderSample: z.number().int().positive().optional(),
    saturationRatio: z.number().positive().max(1).optional(),
  })
  .strict();

// The assistant and its image tool. Strict: the request is built from these fields, so a
// misspelt one would silently fall back to a default.
const ChatPolicySchema = z
  .object({
    model: z.string().min(1).optional(),
    reasoning: z.string().min(1).optional(),
    instructions: z.string().optional(),
    imageModel: z.string().min(1).optional(),
    size: z.string().optional(),
    quality: z.string().optional(),
    background: z.string().optional(),
    output_format: z.string().optional(),
    output_compression: z.number().optional(),
    partial_images: z.number().int().min(0).max(3).optional(),
  })
  .strict();

// ONNX Runtime tuning, given by the caller since the SDK reads no environment.
const OnnxPolicySchema = z
  .object({
    intraOpThreads: z.number().int().positive().optional(),
    executionProviders: z.array(z.string().trim().toLowerCase().min(1)).min(1).optional(),
  })
  .strict();

const SECTION_SCHEMAS: Record<keyof Policy, z.ZodType> = {
  generate: GeneratePolicySchema,
  edit: EditPolicySchema,
  vision: VisionPolicySchema,
  chat: ChatPolicySchema,
  chroma: ChromaPolicySchema,
  network: NetworkSchema,
  onnx: OnnxPolicySchema,
};

/** `policy.invalid` for a section, naming its first faulty field. */
export function policyError(section: string, err: z.ZodError): GptImgError {
  const { field, constraint } = firstZodIssue(err);
  return new GptImgError("policy.invalid", `${section} policy invalid: ${formatZodError(err)}`, {
    details: { section, field, constraint },
  });
}

/**
 * Check a whole policy and return it as checked: unknown sections and fields
 * are refused. The constructor checks the instance's policy and each call the
 * policy it is given, once, so a misspelt section or field fails where it was
 * written; the verbs read the checked sections without checking them again.
 */
export function validatePolicy(input: unknown): Policy {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new GptImgError("policy.invalid", "policy must be an object.", { details: { section: "policy", constraint: "object" } });
  }
  const checked: Record<string, unknown> = {};
  for (const [section, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (!Object.hasOwn(SECTION_SCHEMAS, section)) {
      throw new GptImgError(
        "policy.invalid",
        `policy has no section ${JSON.stringify(section)}; the sections are ${Object.keys(SECTION_SCHEMAS).join(", ")}.`,
        { details: { section, constraint: "known section" } },
      );
    }
    const r = SECTION_SCHEMAS[section as keyof Policy].safeParse(value);
    if (!r.success) throw policyError(section, r.error);
    checked[section] = r.data;
  }
  return checked as Policy;
}
