import { z } from "zod";
import { RecipeError } from "../errors.js";
import { NetworkSchema } from "../network/schema.js";
import type {
  ChromaRecipe,
  EditRecipe,
  GenerateRecipe,
  Recipe,
  VisionRecipe,
} from "../types.js";

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const IMAGE_PARAMS_SHAPE = {
  model: z.string().optional(),
  size: z.string().optional(),
  quality: z.string().optional(),
  n: z.number().int().positive().optional(),
};

export const GenerateRecipeSchema = z.object(IMAGE_PARAMS_SHAPE).passthrough();

export const EditRecipeSchema = z.object(IMAGE_PARAMS_SHAPE).passthrough();

export const VisionShrinkSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const VisionRecipeSchema = z
  .object({
    model: z.string().optional(),
    shrink: VisionShrinkSchema.optional(),
    detail: z.enum(["low", "high", "original", "auto"]).optional(),
    systemPrompt: z.string().optional(),
  })
  .passthrough();

export const ChromaRecipeSchema = z
  .object({
    color: z.string().regex(HEX_COLOR_RE, "Must be a #rrggbb hex color").optional(),
    preserveInterior: z.boolean().optional(),
    innerThreshold: z.number().optional(),
    borderSample: z.number().int().positive().optional(),
    fillHoles: z.boolean().optional(),
    strictConfidence: z.number().optional(),
    verifyThreshold: z.number().optional(),
    backdropInstruction: z.string().optional(),
    verifyInstruction: z.string().optional(),
  })
  .passthrough();

export const RecipeSchema = z
  .object({
    generate: GenerateRecipeSchema.optional(),
    edit: EditRecipeSchema.optional(),
    vision: VisionRecipeSchema.optional(),
    chroma: ChromaRecipeSchema.optional(),
    network: NetworkSchema.optional(),
  })
  .passthrough();

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
}

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
