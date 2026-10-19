import { z } from "zod";
import { HEX_RE } from "../color.ts";
import { VISION_DETAILS } from "../enums.ts";
import { GptImgError } from "../errors.ts";
import { firstZodIssue, formatZodError } from "../internal/zodError.ts";
import { NetworkSchema } from "../network/schema.ts";
import type {
  ChromaPolicy,
  EditPolicy,
  GeneratePolicy,
  OnnxPolicy,
  Policy,
  VisionPolicy,
} from "../types.ts";

// A supported model's values are checked against its row (policy/model-check.ts); here only
// their types are.
// Moderation is not exposed (ai-model-lineup-20261004): generate sends "low" for a supported
// model, so neither section takes it.
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

const GeneratePolicySchema = z.object(IMAGE_PARAMS_SHAPE).passthrough();

const EditPolicySchema = z.object(IMAGE_PARAMS_SHAPE).passthrough();

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
  .passthrough();

const ChromaPolicySchema = z
  .object({
    color: z.string().regex(HEX_RE, "Must be a #rrggbb hex color").optional(),
    preserveInterior: z.boolean().optional(),
    borderSample: z.number().int().positive().optional(),
    saturationRatio: z.number().positive().max(1).optional(),
  })
  .strict();

// ONNX Runtime tuning, formerly the GPTIMG_ONNX_INTRA_OP_THREADS and
// GPTIMG_ONNX_EP environment variables: the SDK reads no environment.
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

export function validateGenerateSection(input: unknown): GeneratePolicy {
  const r = GeneratePolicySchema.safeParse(input ?? {});
  if (!r.success) {
    throw policyError("generate", r.error);
  }
  return r.data as GeneratePolicy;
}

export function validateEditSection(input: unknown): EditPolicy {
  const r = EditPolicySchema.safeParse(input ?? {});
  if (!r.success) {
    throw policyError("edit", r.error);
  }
  return r.data as EditPolicy;
}

export function validateVisionSection(input: unknown): VisionPolicy {
  const r = VisionPolicySchema.safeParse(input ?? {});
  if (!r.success) {
    throw policyError("vision", r.error);
  }
  return r.data as VisionPolicy;
}

export function validateChromaSection(input: unknown): ChromaPolicy {
  const r = ChromaPolicySchema.safeParse(input ?? {});
  if (!r.success) {
    throw policyError("chroma", r.error);
  }
  return r.data as ChromaPolicy;
}

/**
 * Check a whole policy: unknown sections are refused, and each section is
 * checked as its verb will check it. The constructor and each call check the
 * policy they are given, so a misspelt section or field fails where it was
 * written.
 */
export function validatePolicy(input: unknown): Policy {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new GptImgError("policy.invalid", "policy must be an object.", { details: { section: "policy", constraint: "object" } });
  }
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
  }
  return input as Policy;
}

export function validateOnnxSection(input: unknown): OnnxPolicy {
  const r = OnnxPolicySchema.safeParse(input ?? {});
  if (!r.success) throw policyError("onnx", r.error);
  return r.data;
}
