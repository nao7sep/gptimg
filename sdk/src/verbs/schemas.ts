/**
 * Per-verb argument validation — the single source of truth for every static
 * argument constraint in the SDK: required fields, numeric ranges, enum
 * membership, and cross-argument arity. Each verb's public `*Impl` calls its
 * `validate<Verb>Args` first, before any I/O or logging, so a malformed
 * invocation fails identically for every caller.
 *
 * Scope: only *static* checks live here (things decidable from the arguments
 * alone). Data-dependent preconditions that need decoded pixels or the
 * filesystem — "the master must be square", "the top must fit the base",
 * a name collision — stay in the compute layer, where the data is available.
 *
 * Every failure is raised as `GptImgError("args.invalid", …)` — one code a
 * caller can branch on for any static argument fault — with the faulty field
 * and its constraint in `details`. Every path argument must be absolute: the
 * SDK reads no working directory. Mirrors the policy-section validators in
 * policy/schemas.ts.
 *
 * Messages are constraint-only ("must be in (0..1]"); `formatZodError` prefixes
 * the field path, so the rendered form reads "<verb>: <field>: <constraint>".
 */

import path from "node:path";
import { z } from "zod";
import { HEX_RE } from "../color.ts";
import {
  BACKPLATE_SHAPES,
  COMBINE_OPS,
  DESPECKLE_KEEP,
  ENCODE_FORMATS,
  FRAMECHECK_AXES,
  LAYER_GRAVITIES,
  MASK_METHODS,
  RESAMPLE_KERNELS,
} from "../enums.ts";
import { GptImgError } from "../errors.ts";
import { assertAbsolutePath } from "../internal/absolute-path.ts";
import { firstZodIssue, formatZodError } from "../internal/zodError.ts";
import { MODELS } from "../local/models/registry.ts";
import { NO_LOG_HINT } from "./options.ts";
import { SWIN2SR_MIN_TILE } from "../local/models/swin2sr-constants.ts";
import type {
  BackplateArgs,
  ChatArgs,
  CombineArgs,
  ComposeArgs,
  DespeckleArgs,
  EditArgs,
  EncodeArgs,
  EncodingArgs,
  FramecheckArgs,
  GenerateArgs,
  GridArgs,
  IconArgs,
  InspectArgs,
  KeycheckArgs,
  LayerArgs,
  MaskArgs,
  PngEncodingArgs,
  ResizeArgs,
  ShadowArgs,
  TrimArgs,
  UpscaleArgs,
  VerifyArgs,
  VisionArgs,
} from "../types.ts";
import { ENCODING_DEFAULTS } from "../defaults.ts";

// ----- numeric limits: the validator owns the bounds it enforces -----

// sharp's accepted gaussian blur sigma range; `0` means "no blur".
const SHADOW_MIN_BLUR = 0.3;
const SHADOW_MAX_BLUR = 1000;
// Sizes, spreads, offsets and feather radii have no upper bound
// (volume-handling-conventions): a value too large for the machine fails as
// `memory.exhausted` at the verb boundary instead of being refused by a number.

// ----- shared field fragments -----

const requiredPath = (label: string) => z.string().min(1, `${label} is required`);

const nonBlankText = (label: string) =>
  z.string().refine((value) => value.trim().length > 0, `${label} must not be blank`);

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

// The encoder options of every verb that writes an image; the format-dependent rules between
// them are `checkEncoding`'s, because they need the whole argument set.
const PNG_ENCODING_FIELDS = {
  compressionLevel: z
    .number()
    .refine((v) => Number.isInteger(v) && v >= 0 && v <= 9, "must be an integer in [0..9]")
    .optional(),
  adaptiveFiltering: z.boolean().optional(),
};

const ENCODING_FIELDS = {
  ...PNG_ENCODING_FIELDS,
  format: oneOf(ENCODE_FORMATS, "format").optional(),
  quality: z
    .number()
    .refine((v) => Number.isInteger(v) && v >= 1 && v <= 100, "must be an integer in [1..100]")
    .optional(),
  lossless: z.boolean().optional(),
  smartSubsample: z.boolean().optional(),
  opaque: z.boolean().optional(),
  background: z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a #rrggbb colour").optional(),
};

// Where an output lands; `outName` is checked as a stem where it is resolved.
const OUTPUT_FIELDS = {
  outDir: requiredPath("outDir").optional(),
  outName: z.string().optional(),
  overwrite: z.boolean().optional(),
};

// A verb that writes one file also takes its exact path; `out` is checked where it is resolved.
const FILE_OUTPUT_FIELDS = {
  ...OUTPUT_FIELDS,
  out: requiredPath("out").optional(),
};

// A per-call policy; its sections are checked by `validatePolicy` where the call merges it.
const policyField = z.record(z.string(), z.unknown()).optional();
const modelsDirField = requiredPath("modelsDir").optional();

// The verbs with no input folder to default to need a destination: a folder, or an absolute stem.
const DESTINATION_REQUIRED = {
  check: (args: { outDir?: string | undefined; outName?: string | undefined; out?: string | undefined }) =>
    args.out !== undefined || args.outDir !== undefined || (args.outName !== undefined && path.isAbsolute(args.outName)),
  message: { path: ["outDir"], message: "choose an output directory, or use an absolute outName" },
};

// ----- schemas -----

const GenerateArgsSchema = z.object({
  ...OUTPUT_FIELDS,
  prompt: nonBlankText("prompt"),
  policy: policyField,
}).refine(DESTINATION_REQUIRED.check, DESTINATION_REQUIRED.message);

const EditArgsSchema = z.object({
  ...OUTPUT_FIELDS,
  prompt: nonBlankText("prompt"),
  in: requiredPath("in"),
  mask: requiredPath("mask").optional(),
  policy: policyField,
});

const VisionArgsSchema = z.object({
  inputs: z.array(z.string().min(1)).min(1),
  check: nonBlankText("check"),
  ...OUTPUT_FIELDS,
  policy: policyField,
});

const MaskArgsSchema = z.object({
  ...PNG_ENCODING_FIELDS,
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
  preserveInterior: z.boolean().optional(),
  ...FILE_OUTPUT_FIELDS,
  modelsDir: modelsDirField,
  policy: policyField,
});

const ComposeArgsSchema = z.object({
  ...ENCODING_FIELDS,
  in: requiredPath("in"),
  mask: requiredPath("mask"),
  removeBleed: hexColor("removeBleed").optional(),
  ...FILE_OUTPUT_FIELDS,
  // "transparent" | #hex | <path>, resolved against the filesystem at runtime.
  over: z.string().min(1).optional(),
});

const CombineArgsSchema = z.object({
  ...PNG_ENCODING_FIELDS,
  op: oneOf(COMBINE_OPS, "op"),
  inputs: z.array(z.string().min(1)),
  radius: z
    .number()
    .refine((v) => v >= 0, "must be >= 0")
    .optional(),
  ...FILE_OUTPUT_FIELDS,
});

const TrimArgsSchema = z.object({
  ...ENCODING_FIELDS,
  in: requiredPath("in"),
  margin: z.number().refine((v) => v >= 0 && v <= 1, "must be in [0..1]").optional(),
  square: z.boolean().optional(),
  ...FILE_OUTPUT_FIELDS,
});

const DespeckleArgsSchema = z.object({
  ...ENCODING_FIELDS,
  in: requiredPath("in"),
  threshold: z
    .number()
    .refine((v) => Number.isInteger(v) && v >= 0 && v <= 255, "must be an integer in [0..255]")
    .optional(),
  minArea: z
    .number()
    .refine((v) => Number.isInteger(v) && v >= 0, "must be a non-negative integer")
    .optional(),
  connectivity: z.number().refine((v) => v === 4 || v === 8, "must be 4 or 8").optional(),
  keep: oneOf(DESPECKLE_KEEP, "keep").optional(),
  ...FILE_OUTPUT_FIELDS,
});

const KeycheckArgsSchema = z.object({
  ...ENCODING_FIELDS,
  in: requiredPath("in"),
  // Required and concrete: "from-sidecar" or an explicit hex. No "auto" — there
  // is no background left in a keyed cutout to sample a key from.
  key: z
    .string()
    .refine(
      (v) => v === "from-sidecar" || HEX_RE.test(v),
      "key must be 'from-sidecar' or a #rrggbb hex color",
    ),
  hueTolerance: z.number().refine((v) => v >= 0 && v <= 180, "must be in [0..180]").optional(),
  minSaturation: z.number().refine((v) => v >= 0 && v <= 1, "must be in [0..1]").optional(),
  minValue: z.number().refine((v) => v >= 0 && v <= 1, "must be in [0..1]").optional(),
  maxEdgeResidueFraction: z
    .number()
    .refine((v) => v >= 0 && v <= 1, "must be in [0..1]")
    .optional(),
  maxInteriorResiduePixels: z
    .number()
    .refine((v) => Number.isInteger(v) && v >= 0, "must be a non-negative integer")
    .optional(),
  heatmap: z.boolean().optional(),
  ...FILE_OUTPUT_FIELDS,
});

const FramecheckArgsSchema = z.object({
  in: requiredPath("in"),
  // A "solid" pixel must actually ship, so threshold starts at 1 (not despeckle's
  // 0): threshold 0 would count fully-transparent pixels as the body and make the
  // solid box the whole canvas. threshold 1 means "any shipping pixel is solid".
  threshold: z
    .number()
    .refine((v) => Number.isInteger(v) && v >= 1 && v <= 255, "must be an integer in [1..255]")
    .optional(),
  tolerance: z
    .number()
    .refine((v) => Number.isInteger(v) && v >= 0, "must be a non-negative integer")
    .optional(),
  axes: oneOf(FRAMECHECK_AXES, "axes").optional(),
});

const GridArgsSchema = z.object({
  ...ENCODING_FIELDS,
  inputs: z.array(z.string().min(1)).min(1, "inputs must have at least one path"),
  cols: positiveInt("must be a positive integer").optional(),
  cell: positiveInt("must be a positive integer").optional(),
  gap: z
    .number()
    .refine((v) => Number.isInteger(v) && v >= 0, "must be a non-negative integer")
    .optional(),
  ...FILE_OUTPUT_FIELDS,
  background: z
    .string()
    .refine((v) => v === "transparent" || HEX_RE.test(v), "must be 'transparent' or a #rrggbb hex color")
    .optional(),
});

const BackplateArgsSchema = z.object({
  ...ENCODING_FIELDS,
  ...FILE_OUTPUT_FIELDS,
  from: hexColor("from"),
  to: hexColor("to"),
  size: positiveInt("must be a positive integer").optional(),
  content: z.number().refine((v) => v > 0 && v <= 1, "must be in (0..1]").optional(),
  radius: z.number().refine((v) => v >= 0 && v <= 0.5, "must be in [0..0.5]").optional(),
  angle: z.number().optional(),
  shape: oneOf(BACKPLATE_SHAPES, "shape").optional(),
}).refine(DESTINATION_REQUIRED.check, DESTINATION_REQUIRED.message);

const LayerArgsSchema = z.object({
  ...ENCODING_FIELDS,
  base: requiredPath("base"),
  top: requiredPath("top"),
  scale: z.number().refine((v) => v > 0, "must be a positive number").optional(),
  gravity: oneOf(LAYER_GRAVITIES, "gravity").optional(),
  topOffset: z
    .object({ x: z.number(), y: z.number() })
    .refine((o) => Number.isInteger(o.x) && Number.isInteger(o.y), "topOffset must be integers")
    .optional(),
  ...FILE_OUTPUT_FIELDS,
});

const ShadowArgsSchema = z.object({
  ...ENCODING_FIELDS,
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
    .optional(),
  color: hexColor("color").optional(),
  opacity: z.number().refine((v) => v > 0 && v <= 1, "must be in (0..1]").optional(),
  spread: z
    .number()
    .refine(
      (v) => Number.isInteger(v) && v >= 0,
      "must be an integer >= 0",
    )
    .optional(),
  keepCanvas: z.boolean().optional(),
  ...FILE_OUTPUT_FIELDS,
});

const UpscaleArgsSchema = z.object({
  ...ENCODING_FIELDS,
  in: requiredPath("in"),
  toSize: z
    .number()
    .refine(
      (v) => Number.isInteger(v) && v >= 1,
      "must be an integer >= 1",
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
  ...FILE_OUTPUT_FIELDS,
  modelsDir: modelsDirField,
  policy: policyField,
});

const ResizeArgsSchema = z.object({
  ...ENCODING_FIELDS,
  in: requiredPath("in"),
  toSize: z
    .number()
    .refine(
      (v) => Number.isInteger(v) && v >= 1,
      "must be an integer >= 1",
    ),
  kernel: oneOf(RESAMPLE_KERNELS, "kernel").optional(),
  ...FILE_OUTPUT_FIELDS,
});

const EncodeArgsSchema = z.object({
  in: requiredPath("in"),
  ...ENCODING_FIELDS,
  format: oneOf(ENCODE_FORMATS, "format"),
  ...FILE_OUTPUT_FIELDS,
});

const ChatTurnSchema = z.strictObject({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  images: z.array(z.string().min(1)).optional(),
});

const ChatArgsSchema = z.object({
  message: nonBlankText("message"),
  images: z.array(z.string().min(1)).optional(),
  mask: z.string().min(1).optional(),
  history: z.array(ChatTurnSchema).optional(),
  previousResponseId: z.string().min(1).optional(),
  outDir: requiredPath("outDir"),
  outName: z.string().optional(),
  overwrite: z.boolean().optional(),
  policy: policyField,
});

const VerifyArgsSchema = z.object({
  in: requiredPath("in"),
});

const InspectArgsSchema = z.object({
  in: requiredPath("in"),
});

const IconArgsSchema = z.object({
  ...PNG_ENCODING_FIELDS,
  in: requiredPath("in"),
  outName: z.string().min(1).optional(),
  pngs: z.boolean().optional(),
  outDir: requiredPath("outDir").optional(),
  overwrite: z.boolean().optional(),
});

// ----- runner + public validators -----

// Arguments earlier versions took: refused like any unknown argument, with a
// hint at where the value now goes.
// Arguments a verb took under another name, with the name to use now.
const RENAMED_ARGS: Record<string, Record<string, string>> = {
  icon: { name: "icon's name is now outName" },
  vision: { in: "vision's in is now inputs, an array" },
};

const RETIRED_ARGS: Record<string, string> = {
  recipe: "recipe files are retired; pass policy per call or per instance",
  overrides: "overrides is now policy",
  profile: "profiles are retired; pass apiKey and the other settings to the GptImg constructor",
  log: NO_LOG_HINT,
  dryRun: "mask no longer has dryRun",
};

// Every argument that names a file or folder; each must be absolute.
const PATH_FIELDS = ["in", "mask", "outDir", "base", "top", "modelsDir", "inputs", "images"] as const;

function check<T>(schema: z.ZodObject, args: T, verb: string): T {
  if (typeof args !== "object" || args === null) {
    throw new GptImgError("args.invalid", `${verb}: args must be an object.`, {
      details: { field: "args", constraint: "object" },
    });
  }
  const given = args as Record<string, unknown>;
  // An unknown argument is refused rather than silently ignored, so a misspelt
  // or misplaced option never runs the verb with its default instead.
  const unknown = Object.keys(given).find((key) => given[key] !== undefined && !Object.hasOwn(schema.shape, key));
  if (unknown !== undefined) {
    const renamed = RENAMED_ARGS[verb]?.[unknown];
    const hint = renamed ?? RETIRED_ARGS[unknown] ?? `${verb} takes ${Object.keys(schema.shape).join(", ")}`;
    throw new GptImgError("args.invalid", `${verb}: ${unknown} is not accepted; ${hint}.`, {
      details: { field: unknown, constraint: renamed ? "renamed" : Object.hasOwn(RETIRED_ARGS, unknown) ? "retired" : "known argument" },
    });
  }
  const r = schema.safeParse(args);
  if (!r.success) {
    const { field, constraint } = firstZodIssue(r.error);
    throw new GptImgError("args.invalid", `${verb}: ${formatZodError(r.error)}`, { details: { field, constraint } });
  }
  for (const field of PATH_FIELDS) {
    const value = given[field];
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((v, i) => assertAbsolutePath(v, `${field}[${i}]`, verb));
    else assertAbsolutePath(value, field, verb);
  }
  return args;
}

/** The format-dependent rules of the encoder options, for a verb that takes all of them. */
function checkEncoding<T extends EncodingArgs>(schema: z.ZodObject, args: T, verb: string): T {
  check(schema, args, verb);
  const format = args.format ?? ENCODING_DEFAULTS.format;
  if (format === "png" && (args.quality !== undefined || args.lossless !== undefined || args.smartSubsample !== undefined)) {
    throw new GptImgError(
      "args.invalid",
      `${verb}: quality applies to webp and jpeg, lossless and smartSubsample to webp only; png is always lossless.`,
      { details: { field: "format", constraint: "lossy-format options" } },
    );
  }
  if (format === "jpeg" && (args.lossless !== undefined || args.smartSubsample !== undefined)) {
    throw new GptImgError(
      "args.invalid",
      `${verb}: lossless and smartSubsample apply to webp only.`,
      { details: { field: "format", constraint: "webp-only options" } },
    );
  }
  if (format !== "png" && (args.compressionLevel !== undefined || args.adaptiveFiltering !== undefined)) {
    throw new GptImgError(
      "args.invalid",
      `${verb}: compressionLevel and adaptiveFiltering apply to png only.`,
      { details: { field: "format", constraint: "png-only options" } },
    );
  }
  if (args.background !== undefined && args.opaque === true) {
    throw new GptImgError(
      "args.invalid",
      `${verb}: opaque refuses transparency and background fills it; pass one.`,
      { details: { field: "background", constraint: "not with opaque" } },
    );
  }
  if (args.quality !== undefined && args.lossless === true) {
    throw new GptImgError(
      "args.invalid",
      `${verb}: quality applies to lossy encodings only; omit it with lossless.`,
      { details: { field: "quality", constraint: "lossy webp only" } },
    );
  }
  return args;
}

const NON_PNG_ENCODING_KEYS = ["format", "quality", "lossless", "smartSubsample", "opaque", "background"] as const;

/** The same for a verb whose format is fixed to PNG: only the lossless PNG options are accepted. */
function checkPngEncoding<T extends PngEncodingArgs>(schema: z.ZodObject, args: T, verb: string): T {
  // Before the unknown-argument check, so a webp option on a png-only verb gets its reason.
  const given = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  const refused = NON_PNG_ENCODING_KEYS.find((key) => given[key] !== undefined);
  if (refused !== undefined) {
    throw new GptImgError(
      "args.invalid",
      `${verb}: ${refused} is not accepted; ${verb} writes png and takes compressionLevel and adaptiveFiltering only.`,
      { details: { field: refused, constraint: "png options only" } },
    );
  }
  return check(schema, args, verb);
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
  return checkPngEncoding(MaskArgsSchema, args, "mask");
}

export function validateComposeArgs(args: ComposeArgs): ComposeArgs {
  return checkEncoding(ComposeArgsSchema, args, "compose");
}

export function validateCombineArgs(args: CombineArgs): CombineArgs {
  checkPngEncoding(CombineArgsSchema, args, "combine");
  // Arity depends on the op, so it is checked here rather than in the schema.
  const want = args.op === "invert" || args.op === "feather" ? 1 : 2;
  if (args.inputs.length !== want) {
    throw new GptImgError(
      "args.invalid",
      `combine: ${args.op} expects exactly ${want} input(s); got ${args.inputs.length}.`,
      { details: { field: "inputs", constraint: "count for the op" } },
    );
  }
  return args;
}

export function validateTrimArgs(args: TrimArgs): TrimArgs {
  return checkEncoding(TrimArgsSchema, args, "trim");
}

export function validateDespeckleArgs(args: DespeckleArgs): DespeckleArgs {
  return checkEncoding(DespeckleArgsSchema, args, "despeckle");
}

export function validateKeycheckArgs(args: KeycheckArgs): KeycheckArgs {
  return checkEncoding(KeycheckArgsSchema, args, "keycheck");
}

export function validateFramecheckArgs(args: FramecheckArgs): FramecheckArgs {
  return check(FramecheckArgsSchema, args, "framecheck");
}

export function validateGridArgs(args: GridArgs): GridArgs {
  return checkEncoding(GridArgsSchema, args, "grid");
}

export function validateBackplateArgs(args: BackplateArgs): BackplateArgs {
  return checkEncoding(BackplateArgsSchema, args, "backplate");
}

export function validateLayerArgs(args: LayerArgs): LayerArgs {
  return checkEncoding(LayerArgsSchema, args, "layer");
}

export function validateShadowArgs(args: ShadowArgs): ShadowArgs {
  return checkEncoding(ShadowArgsSchema, args, "shadow");
}

export function validateUpscaleArgs(args: UpscaleArgs): UpscaleArgs {
  return checkEncoding(UpscaleArgsSchema, args, "upscale");
}

export function validateResizeArgs(args: ResizeArgs): ResizeArgs {
  return checkEncoding(ResizeArgsSchema, args, "resize");
}

export function validateEncodeArgs(args: EncodeArgs): EncodeArgs {
  return checkEncoding(EncodeArgsSchema, args, "encode");
}

export function validateChatArgs(args: ChatArgs): ChatArgs {
  check(ChatArgsSchema, args, "chat");
  // Each earlier turn's images are paths too, and must be absolute like every other.
  args.history?.forEach((turn, t) => turn.images?.forEach((image, i) => assertAbsolutePath(image, `history[${t}].images[${i}]`, "chat")));
  if (args.mask !== undefined) {
    assertAbsolutePath(args.mask, "mask", "chat");
    if (!args.images?.length) {
      throw new GptImgError("args.invalid", "chat: mask applies to the first image, but no image is attached.", {
        details: { field: "mask", constraint: "an attached image" },
      });
    }
  }
  return args;
}

export function validateVerifyArgs(args: VerifyArgs): VerifyArgs {
  return check(VerifyArgsSchema, args, "verify");
}

export function validateInspectArgs(args: InspectArgs): InspectArgs {
  return check(InspectArgsSchema, args, "inspect");
}

export function validateIconArgs(args: IconArgs): IconArgs {
  return checkPngEncoding(IconArgsSchema, args, "icon");
}

/** Validate a model key against the registry. Throws `args.invalid` when unknown. */
export function validateModelKey(key: string): void {
  // Own-property check: `key in MODELS` would accept inherited keys like
  // "toString" / "constructor", which then read a function as the model entry.
  if (!Object.hasOwn(MODELS, key)) {
    throw new GptImgError(
      "args.invalid",
      `unknown model "${key}"; known: ${Object.keys(MODELS).join(", ")}.`,
      { details: { field: "key", constraint: "a known model" } },
    );
  }
}
