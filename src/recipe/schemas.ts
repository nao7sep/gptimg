import { z } from "zod";
import { RecipeError } from "../errors.js";
import type {
  EditRecipe,
  GenerateRecipe,
  Recipe,
  RecipeVerb,
  VisionRecipe,
} from "../types.js";

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export const ChromaKeyHintSchema = z
  .object({
    color: z.string().regex(HEX_COLOR_RE, "Must be a #rrggbb hex color"),
  })
  .passthrough();

export const GenerateRecipeSchema = z
  .object({
    size: z.string().optional(),
    quality: z.string().optional(),
    n: z.number().int().positive().optional(),
    chromaKey: ChromaKeyHintSchema.nullable().optional(),
  })
  .passthrough();

export const EditRecipeSchema = z
  .object({
    size: z.string().optional(),
  })
  .passthrough();

export const VisionShrinkSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const VisionRecipeSchema = z
  .object({
    shrink: VisionShrinkSchema.optional(),
  })
  .passthrough();

export const RecipeSchema = z
  .object({
    generate: GenerateRecipeSchema.optional(),
    edit: EditRecipeSchema.optional(),
    vision: VisionRecipeSchema.optional(),
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

export function sectionValidator(verb: RecipeVerb): (input: unknown) => unknown {
  switch (verb) {
    case "generate":
      return validateGenerateSection;
    case "edit":
      return validateEditSection;
    case "vision":
      return validateVisionSection;
  }
}
