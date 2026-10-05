import { z } from "zod";
import { HEX_RE } from "../color.js";
import { VISION_DETAILS } from "../enums.js";
import { RecipeError } from "../errors.js";
import { formatZodError } from "../internal/zodError.js";
import { NetworkSchema } from "../network/schema.js";
import type {
  ChromaRecipe,
  EditRecipe,
  GenerateRecipe,
  Recipe,
  VisionRecipe,
} from "../types.js";

// A supported model's values are checked against its row (recipe/model-check.ts); here only
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
    .never({ error: 'moderation is not a recipe field; generate sends moderation "low" for a supported model' })
    .optional(),
};

const GenerateRecipeSchema = z.object(IMAGE_PARAMS_SHAPE).passthrough();

const EditRecipeSchema = z.object(IMAGE_PARAMS_SHAPE).passthrough();

const VisionShrinkSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

const VisionRecipeSchema = z
  .object({
    model: z.string().optional(),
    shrink: VisionShrinkSchema.optional(),
    detail: z.enum(VISION_DETAILS).optional(),
    reasoning: z.string().optional(),
    // The effort is sent from `reasoning`, so a passed-through wire field would be overwritten.
    reasoning_effort: z
      .never({ error: "reasoning_effort is not a recipe field; set reasoning, which gptimg sends as reasoning_effort for a supported model" })
      .optional(),
    systemPrompt: z.string().optional(),
  })
  .passthrough();

const ChromaRecipeSchema = z
  .object({
    color: z.string().regex(HEX_RE, "Must be a #rrggbb hex color").optional(),
    preserveInterior: z.boolean().optional(),
    borderSample: z.number().int().positive().optional(),
    saturationRatio: z.number().positive().max(1).optional(),
  })
  .passthrough();

const RecipeSchema = z
  .object({
    generate: GenerateRecipeSchema.optional(),
    edit: EditRecipeSchema.optional(),
    vision: VisionRecipeSchema.optional(),
    chroma: ChromaRecipeSchema.optional(),
    network: NetworkSchema.optional(),
  })
  .passthrough();

export function validateGenerateSection(input: unknown): GenerateRecipe {
  const r = GenerateRecipeSchema.safeParse(input ?? {});
  if (!r.success) {
    throw new RecipeError(
      "recipe.validationFailed",
      `generate section invalid: ${formatZodError(r.error)}`,
    );
  }
  return r.data as GenerateRecipe;
}

export function validateEditSection(input: unknown): EditRecipe {
  const r = EditRecipeSchema.safeParse(input ?? {});
  if (!r.success) {
    throw new RecipeError(
      "recipe.validationFailed",
      `edit section invalid: ${formatZodError(r.error)}`,
    );
  }
  return r.data as EditRecipe;
}

export function validateVisionSection(input: unknown): VisionRecipe {
  const r = VisionRecipeSchema.safeParse(input ?? {});
  if (!r.success) {
    throw new RecipeError(
      "recipe.validationFailed",
      `vision section invalid: ${formatZodError(r.error)}`,
    );
  }
  return r.data as VisionRecipe;
}

export function validateChromaSection(input: unknown): ChromaRecipe {
  const r = ChromaRecipeSchema.safeParse(input ?? {});
  if (!r.success) {
    throw new RecipeError(
      "recipe.validationFailed",
      `chroma section invalid: ${formatZodError(r.error)}`,
    );
  }
  return r.data as ChromaRecipe;
}

export function validateRecipe(input: unknown): Recipe {
  const r = RecipeSchema.safeParse(input ?? {});
  if (!r.success) {
    throw new RecipeError(
      "recipe.validationFailed",
      `recipe invalid: ${formatZodError(r.error)}`,
    );
  }
  return r.data as Recipe;
}
