// The models GptImg supports and how it splits its AI work (ai-model-routing-conventions).
// The app keeps its own table, structurally alike to the SDK's: the SDK checks and sends each
// request, and this table fills Settings, its defaults and warnings, and the composer's choices.
// Ids are matched without regard to case, and a matched id is stored and sent in its row's spelling.

/** The lineup research document these rows and defaults come from. */
export const MODEL_LINEUP = "ai-model-lineup-20261004";

export type AiProvider = "openai";
export type AiKind = "chat" | "image-edit";

/** The size rule an image row takes besides `auto` (the SDK's rule, restated here for the composer). */
export interface ImageSizeRule {
  readonly multipleOf: number;
  readonly maxRatio: number;
  readonly minPixels: number;
  readonly maxPixels: number;
}

export interface ModelRow {
  readonly provider: AiProvider;
  readonly id: string;
  readonly kinds: readonly AiKind[];
  readonly defaultFor: readonly AiKind[];
}

export interface ImageModelRow extends ModelRow {
  readonly image: { readonly qualities: readonly string[]; readonly size: ImageSizeRule };
}

/** A mainline model that leads a conversation and calls the image tool. */
export interface ChatModelRow extends ModelRow {
  /** The `reasoning_effort` values the model accepts, in the order a choice lists them. */
  readonly thinking: readonly string[];
  readonly defaultThinking: string;
}

export type SupportedModel = ImageModelRow | ChatModelRow;

const IMAGE_SIZE: ImageSizeRule = { multipleOf: 16, maxRatio: 3, minPixels: 655_360, maxPixels: 8_294_400 };
const IMAGE_2_5_QUALITIES = ["auto", "low", "medium", "high", "xhigh", "max"] as const;

export const SUPPORTED_MODELS: readonly SupportedModel[] = [
  { provider: "openai", id: "gpt-image-2.5-flare", kinds: ["image-edit"], defaultFor: [], image: { qualities: IMAGE_2_5_QUALITIES, size: IMAGE_SIZE } },
  { provider: "openai", id: "gpt-image-2.5-sunburst", kinds: ["image-edit"], defaultFor: ["image-edit"], image: { qualities: IMAGE_2_5_QUALITIES, size: IMAGE_SIZE } },
  { provider: "openai", id: "gpt-image-2", kinds: ["image-edit"], defaultFor: [], image: { qualities: ["auto", "low", "medium", "high"], size: IMAGE_SIZE } },
  { provider: "openai", id: "gpt-6-astra", kinds: ["chat"], defaultFor: [], thinking: ["low", "medium", "high", "xhigh", "max"], defaultThinking: "medium" },
  { provider: "openai", id: "gpt-6.1-sol", kinds: ["chat"], defaultFor: [], thinking: ["low", "medium", "high", "xhigh", "max"], defaultThinking: "medium" },
  { provider: "openai", id: "gpt-5.6-terra", kinds: ["chat"], defaultFor: ["chat"], thinking: ["none", "low", "medium", "high", "xhigh", "max"], defaultThinking: "medium" },
  { provider: "openai", id: "gpt-6-luna", kinds: ["chat"], defaultFor: [], thinking: ["none", "low", "medium", "high", "xhigh", "max"], defaultThinking: "none" },
];

export const AI_ROLES = [
  // Leads the conversation: reads it, answers in words and calls the image tool. The balanced
  // tier follows long conversations and phrases image requests well without the frontier's cost.
  { id: "chat", kind: "chat", setting: "openai.chat" },
  // The image tool's model, which draws and changes the images; a conversation is mostly
  // refinement, so the precise editing model suits it.
  { id: "image", kind: "image-edit", setting: "openai.image" },
] as const satisfies readonly { id: string; kind: AiKind; setting: string }[];

export function modelsFor(provider: AiProvider, kind: AiKind): readonly SupportedModel[] {
  return SUPPORTED_MODELS.filter((row) => row.provider === provider && row.kinds.includes(kind));
}

export function defaultModelFor(provider: AiProvider, kind: AiKind): string {
  const rows = modelsFor(provider, kind);
  const row = rows.find((candidate) => candidate.defaultFor.includes(kind)) ?? rows[0];
  if (!row) throw new Error(`No supported ${provider} model for ${kind}.`);
  return row.id;
}

/** The row an id names, compared trimmed and without regard to case; undefined for an id with no row. */
export function findModelRow(id: string): SupportedModel | undefined {
  const want = id.trim().toLowerCase();
  return SUPPORTED_MODELS.find((row) => row.id.toLowerCase() === want);
}

/** An id as it is stored and sent: its row's spelling, or as entered (trimmed) when it has no row. */
export function modelSpelling(id: string): string {
  return findModelRow(id)?.id ?? id.trim();
}
