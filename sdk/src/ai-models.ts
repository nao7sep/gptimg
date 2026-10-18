// The models gptimg supports and how it splits its AI work (ai-model-routing-conventions).
// Nothing else decides which model a call uses: a caller's `model` param wins, and without
// one the role's default from this table applies.

/** The lineup research document these rows and defaults come from. */
export const MODEL_LINEUP = "ai-model-lineup-20261004";

export type AiProvider = "openai";
export type AiKind = "image-generate" | "image-edit" | "vision";

/** The size rule an image row takes besides `auto`: both sides divisible by `multipleOf`, the
 * long side at most `maxRatio` times the short one, and the area within the pixel bounds. */
export interface ImageSizeRule {
  readonly multipleOf: number;
  readonly maxRatio: number;
  readonly minPixels: number;
  readonly maxPixels: number;
}

/** The values an image row accepts, checked before any paid call. */
export interface ImageCapabilities {
  readonly qualities: readonly string[];
  readonly backgrounds: readonly string[];
  readonly outputFormats: readonly string[];
  /** `output_compression`'s range and the formats it applies to. */
  readonly compression: { readonly min: number; readonly max: number; readonly formats: readonly string[] };
  readonly size: ImageSizeRule;
}

interface ModelRow {
  readonly provider: AiProvider;
  readonly id: string;
  readonly kinds: readonly AiKind[];
  readonly defaultFor: readonly AiKind[];
}

export interface ImageModelRow extends ModelRow {
  readonly image: ImageCapabilities;
}

export interface VisionModelRow extends ModelRow {
  /** The `reasoning_effort` values the model accepts, in the order a choice lists them. */
  readonly thinking: readonly string[];
  /** The model's own tier default (the fast tier: none; every other tier: medium). */
  readonly defaultThinking: string;
}

export type SupportedModel = ImageModelRow | VisionModelRow;

const IMAGE_BACKGROUNDS = ["auto", "transparent", "opaque"] as const;
const IMAGE_FORMATS = ["png", "jpeg", "webp"] as const;
const IMAGE_COMPRESSION = { min: 0, max: 100, formats: ["jpeg", "webp"] } as const;
const IMAGE_SIZE: ImageSizeRule = { multipleOf: 16, maxRatio: 3, minPixels: 655_360, maxPixels: 8_294_400 };
const IMAGE_2_5_QUALITIES = ["auto", "low", "medium", "high", "xhigh", "max"] as const;

export const SUPPORTED_MODELS: readonly SupportedModel[] = [
  {
    provider: "openai", id: "gpt-image-2.5-flare", kinds: ["image-generate", "image-edit"], defaultFor: ["image-generate"],
    image: { qualities: IMAGE_2_5_QUALITIES, backgrounds: IMAGE_BACKGROUNDS, outputFormats: IMAGE_FORMATS, compression: IMAGE_COMPRESSION, size: IMAGE_SIZE },
  },
  {
    provider: "openai", id: "gpt-image-2.5-sunburst", kinds: ["image-generate", "image-edit"], defaultFor: ["image-edit"],
    image: { qualities: IMAGE_2_5_QUALITIES, backgrounds: IMAGE_BACKGROUNDS, outputFormats: IMAGE_FORMATS, compression: IMAGE_COMPRESSION, size: IMAGE_SIZE },
  },
  {
    provider: "openai", id: "gpt-image-2", kinds: ["image-generate", "image-edit"], defaultFor: [],
    image: { qualities: ["auto", "low", "medium", "high"], backgrounds: IMAGE_BACKGROUNDS, outputFormats: IMAGE_FORMATS, compression: IMAGE_COMPRESSION, size: IMAGE_SIZE },
  },
  { provider: "openai", id: "gpt-6-astra", kinds: ["vision"], defaultFor: [], thinking: ["low", "medium", "high", "xhigh", "max"], defaultThinking: "medium" },
  { provider: "openai", id: "gpt-6.1-sol", kinds: ["vision"], defaultFor: [], thinking: ["low", "medium", "high", "xhigh", "max"], defaultThinking: "medium" },
  { provider: "openai", id: "gpt-5.6-terra", kinds: ["vision"], defaultFor: [], thinking: ["none", "low", "medium", "high", "xhigh", "max"], defaultThinking: "medium" },
  { provider: "openai", id: "gpt-6-luna", kinds: ["vision"], defaultFor: ["vision"], thinking: ["none", "low", "medium", "high", "xhigh", "max"], defaultThinking: "none" },
];

export const AI_ROLES = [
  // Creates images from a prompt; the fast everyday image model suits it.
  { id: "generate", kind: "image-generate" },
  // Changes an existing image from a prompt and optional mask; the precise editing model suits it.
  { id: "edit", kind: "image-edit" },
  // Judges images against a yes/no criterion. Its checks are not expected to find complex or
  // very small defects, so the fast tier's default model suits it. The default must honour
  // `detail`, which some models ignore; the live suite checks gpt-6-luna bills low detail low.
  { id: "vision", kind: "vision" },
] as const satisfies readonly { id: string; kind: AiKind }[];

export type AiRole = (typeof AI_ROLES)[number]["id"];

export function modelsFor(provider: AiProvider, kind: AiKind): readonly SupportedModel[] {
  return SUPPORTED_MODELS.filter((row) => row.provider === provider && row.kinds.includes(kind));
}

export function defaultModelFor(provider: AiProvider, kind: AiKind): string {
  const rows = modelsFor(provider, kind);
  const row = rows.find((candidate) => candidate.defaultFor.includes(kind)) ?? rows[0];
  if (!row) throw new Error(`No supported ${provider} model for ${kind}.`);
  return row.id;
}
