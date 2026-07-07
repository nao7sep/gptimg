import { z } from "zod";
import { HEX_RE } from "../color.js";
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

const IMAGE_PARAMS_SHAPE = {
  model: z.string().optional(),
  size: z.string().optional(),
  quality: z.string().optional(),
  n: z.number().int().positive().optional(),
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
    detail: z.enum(["low", "high", "original", "auto"]).optional(),
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
