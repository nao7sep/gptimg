/**
 * Per-verb argument validation — the single source of truth for every static
 * argument constraint in the SDK: required fields, numeric ranges, enum
 * membership, and cross-argument arity. Each verb's public `*Impl` calls its
 * `validate<Verb>Args` first, before any I/O or logging, so a malformed
 * invocation fails identically whether it came from the CLI or a library
 * caller.
 *
 * Scope: only *static* checks live here (things decidable from the arguments
 * alone). Data-dependent preconditions that need decoded pixels or the
 * filesystem — "the master must be square", "the top must fit the base",
 * a name collision — stay in the compute layer, where the data is available.
 *
 * Every failure is raised as `LocalOpError("args.invalid", …)`, the shared
 * usage-error code, so the CLI maps all of them to the usage exit code and a
 * one-line message. Mirrors the recipe-section validators in recipe/schemas.ts.
 *
 * Messages are constraint-only ("must be in (0..1]"); `formatZodError` prefixes
 * the field path, so the rendered form reads "<verb>: <field>: <constraint>".
 */

import path from "node:path";
import { z } from "zod";
import { HEX_RE } from "../color.js";
import {
  BACKPLATE_SHAPES,
  COMBINE_OPS,
  LAYER_GRAVITIES,
  MASK_METHODS,
  RESAMPLE_KERNELS,
} from "../enums.js";
import { LocalOpError } from "../errors.js";
import { formatZodError } from "../internal/zodError.js";
import { MODELS } from "../local/models/registry.js";
import { SWIN2SR_MIN_TILE } from "../local/models/swin2sr-constants.js";
import type {
  BackplateArgs,
  CombineArgs,
  ComposeArgs,
  EditArgs,
  GenerateArgs,
  IconArgs,
  LayerArgs,
  MaskArgs,
  ResizeArgs,
  ShadowArgs,
  TrimArgs,
  UpscaleArgs,
  VisionArgs,
} from "../types.js";

// ----- numeric limits: the validator owns the bounds it enforces -----

// sharp's accepted gaussian blur sigma range; `0` means "no blur".
const SHADOW_MIN_BLUR = 0.3;
const SHADOW_MAX_BLUR = 1000;
// Upper bounds so spread/offset padding can't balloon the canvas into an OOM.
const SHADOW_MAX_SPREAD = 1024;
const SHADOW_MAX_OFFSET = 10000;
// upscale runs the ×4 model + holds a 4× intermediate, so it is far more
// memory-heavy per output pixel than resize's single resample.
const UPSCALE_MAX_TO_SIZE = 8192;
const RESIZE_MAX_TO_SIZE = 16384;

// ----- shared field fragments -----

const requiredPath = (label: string) => z.string().min(1, `${label} is required`);

const hexColor = (label: string) =>
  z.string().regex(HEX_RE, `${label} must be a #rrggbb hex color`);

// Note: z.number() already rejects Infinity and NaN (Zod 4), so a separate
// "finite" refinement would be unreachable — bounds below only check range/sign.
const positiveInt = (msg: string) =>
  z.number().refine((v) => Number.isInteger(v) && v > 0, msg);

/**
 * Enum membership as a refinement over a plain string — accepts the shared
 * `as const` token list from enums.ts and produces the "must be one of …"
 * message the verbs used before. Avoids depending on z.enum's tuple typing
 * since the validators return their original (already-typed) arguments.
 */
function oneOf(values: readonly string[], label: string) {
  return z
    .string()
    .refine((v) => values.includes(v), `${label} must be one of: ${values.join(", ")}`);
}

// ----- schemas -----

const GenerateArgsSchema = z.object({
  prompt: z.string().min(1, "prompt must not be empty"),
});

const EditArgsSchema = z.object({
  prompt: z.string().min(1, "prompt must not be empty"),
  in: requiredPath("in"),
});

const VisionArgsSchema = z.object({
  in: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  check: z.string().min(1, "check must not be empty"),
});

const MaskArgsSchema = z.object({
  in: requiredPath("in"),
  method: oneOf(MASK_METHODS, "method").optional(),
  key: z
    .string()
    .refine(
      (v) => v === "auto" || v === "from-sidecar" || HEX_RE.test(v),
      "key must be 'auto', 'from-sidecar', or a #rrggbb hex color",
    )
    .optional(),
  borderSample: positiveInt("must be a positive integer").optional(),
  saturationRatio: z.number().refine((v) => v > 0 && v <= 1, "must be in (0..1]").optional(),
});

const ComposeArgsSchema = z.object({
  in: requiredPath("in"),
  mask: requiredPath("mask"),
  // `over` ("transparent" | #hex | <path>) is resolved against the filesystem
  // at runtime, so it is not bounded here.
  removeBleed: hexColor("removeBleed").optional(),
});

const CombineArgsSchema = z.object({
  op: oneOf(COMBINE_OPS, "op"),
  inputs: z.array(z.string().min(1)),
  radius: z.number().refine((v) => v >= 0, "must be a non-negative number").optional(),
});

const TrimArgsSchema = z.object({
  in: requiredPath("in"),
  margin: z.number().refine((v) => v >= 0 && v <= 1, "must be in [0..1]").optional(),
});

const BackplateArgsSchema = z.object({
  from: hexColor("from"),
  to: hexColor("to"),
  size: positiveInt("must be a positive integer").optional(),
  content: z.number().refine((v) => v > 0 && v <= 1, "must be in (0..1]").optional(),
  radius: z.number().refine((v) => v >= 0 && v <= 0.5, "must be in [0..0.5]").optional(),
  angle: z.number().optional(),
  shape: oneOf(BACKPLATE_SHAPES, "shape").optional(),
});

const LayerArgsSchema = z.object({
  base: requiredPath("base"),
  top: requiredPath("top"),
  scale: z.number().refine((v) => v > 0, "must be a positive number").optional(),
  gravity: oneOf(LAYER_GRAVITIES, "gravity").optional(),
  topOffset: z
    .object({ x: z.number(), y: z.number() })
    .refine((o) => Number.isInteger(o.x) && Number.isInteger(o.y), "topOffset must be integers")
    .optional(),
});

const ShadowArgsSchema = z.object({
  in: requiredPath("in"),
  blur: z
    .number()
    .refine(
      (b) => b === 0 || (b >= SHADOW_MIN_BLUR && b <= SHADOW_MAX_BLUR),
      `must be 0 or between ${SHADOW_MIN_BLUR} and ${SHADOW_MAX_BLUR}`,
    )
    .optional(),
  offset: z
    .object({ x: z.number(), y: z.number() })
    .refine((o) => Number.isInteger(o.x) && Number.isInteger(o.y), "offset must be integers")
    .refine(
      (o) => Math.abs(o.x) <= SHADOW_MAX_OFFSET && Math.abs(o.y) <= SHADOW_MAX_OFFSET,
      `offset components must be within ±${SHADOW_MAX_OFFSET}`,
    )
    .optional(),
  color: hexColor("color").optional(),
  opacity: z.number().refine((v) => v > 0 && v <= 1, "must be in (0..1]").optional(),
  spread: z
    .number()
    .refine(
      (v) => Number.isInteger(v) && v >= 0 && v <= SHADOW_MAX_SPREAD,
      `must be an integer in [0..${SHADOW_MAX_SPREAD}]`,
    )
    .optional(),
});

const UpscaleArgsSchema = z.object({
  in: requiredPath("in"),
  toSize: z
    .number()
    .refine(
      (v) => Number.isInteger(v) && v >= 1 && v <= UPSCALE_MAX_TO_SIZE,
      `must be an integer in [1..${UPSCALE_MAX_TO_SIZE}]`,
    )
    .optional(),
  kernel: oneOf(RESAMPLE_KERNELS, "kernel").optional(),
  tile: z
    .number()
    .refine(
      (v) => Number.isInteger(v) && v >= SWIN2SR_MIN_TILE,
      `must be an integer >= ${SWIN2SR_MIN_TILE}`,
    )
    .optional(),
});

const ResizeArgsSchema = z.object({
  in: requiredPath("in"),
  toSize: z
    .number()
    .refine(
      (v) => Number.isInteger(v) && v >= 1 && v <= RESIZE_MAX_TO_SIZE,
      `must be an integer in [1..${RESIZE_MAX_TO_SIZE}]`,
    ),
  kernel: oneOf(RESAMPLE_KERNELS, "kernel").optional(),
});

const IconArgsSchema = z.object({
  in: requiredPath("in"),
  name: z
    .string()
    .refine(
      (n) => n.length > 0 && path.basename(n) === n,
      "name must be a plain filename stem (no path separators)",
    )
    .optional(),
});

// ----- runner + public validators -----

function check<T>(schema: z.ZodType, args: T, verb: string): T {
  const r = schema.safeParse(args);
  if (!r.success) {
    throw new LocalOpError("args.invalid", `${verb}: ${formatZodError(r.error)}`);
  }
  return args;
}

export function validateGenerateArgs(args: GenerateArgs): GenerateArgs {
  return check(GenerateArgsSchema, args, "generate");
}

export function validateEditArgs(args: EditArgs): EditArgs {
  return check(EditArgsSchema, args, "edit");
}

export function validateVisionArgs(args: VisionArgs): VisionArgs {
  return check(VisionArgsSchema, args, "vision");
}

export function validateMaskArgs(args: MaskArgs): MaskArgs {
  return check(MaskArgsSchema, args, "mask");
}

export function validateComposeArgs(args: ComposeArgs): ComposeArgs {
  return check(ComposeArgsSchema, args, "compose");
}

export function validateCombineArgs(args: CombineArgs): CombineArgs {
  check(CombineArgsSchema, args, "combine");
  // Arity depends on the op, so it is checked here rather than in the schema.
  const want = args.op === "invert" || args.op === "feather" ? 1 : 2;
  if (args.inputs.length !== want) {
    throw new LocalOpError(
      "args.invalid",
      `combine: ${args.op} expects exactly ${want} input(s); got ${args.inputs.length}.`,
    );
  }
  return args;
}

export function validateTrimArgs(args: TrimArgs): TrimArgs {
  return check(TrimArgsSchema, args, "trim");
}

export function validateBackplateArgs(args: BackplateArgs): BackplateArgs {
  return check(BackplateArgsSchema, args, "backplate");
}

export function validateLayerArgs(args: LayerArgs): LayerArgs {
  return check(LayerArgsSchema, args, "layer");
}

export function validateShadowArgs(args: ShadowArgs): ShadowArgs {
  return check(ShadowArgsSchema, args, "shadow");
}

export function validateUpscaleArgs(args: UpscaleArgs): UpscaleArgs {
  return check(UpscaleArgsSchema, args, "upscale");
}

export function validateResizeArgs(args: ResizeArgs): ResizeArgs {
  return check(ResizeArgsSchema, args, "resize");
}

export function validateIconArgs(args: IconArgs): IconArgs {
  return check(IconArgsSchema, args, "icon");
}

/** Validate a model key against the registry. Throws `args.invalid` when unknown. */
export function validateModelKey(key: string): void {
  // Own-property check: `key in MODELS` would accept inherited keys like
  // "toString" / "constructor", which then read a function as the model entry.
  if (!Object.hasOwn(MODELS, key)) {
    throw new LocalOpError(
      "args.invalid",
      `unknown model "${key}"; known: ${Object.keys(MODELS).join(", ")}.`,
    );
  }
}
