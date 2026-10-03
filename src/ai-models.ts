// The models gptimg supports and how it splits its AI work (ai-model-routing-conventions).
// Nothing else decides which model a call uses: a caller's `model` param wins, and without
// one the role's default from this table applies.

export type AiProvider = "openai";
export type AiKind = "image-generate" | "image-edit" | "vision";

export interface SupportedModel {
  readonly provider: AiProvider;
  readonly id: string;
  readonly kinds: readonly AiKind[];
  readonly defaultFor: readonly AiKind[];
}

export const SUPPORTED_MODELS: readonly SupportedModel[] = [
  { provider: "openai", id: "gpt-image-2.5-flare", kinds: ["image-generate", "image-edit"], defaultFor: ["image-generate"] },
  { provider: "openai", id: "gpt-image-2.5-sunburst", kinds: ["image-generate", "image-edit"], defaultFor: ["image-edit"] },
  { provider: "openai", id: "gpt-image-2", kinds: ["image-generate", "image-edit"], defaultFor: [] },
  { provider: "openai", id: "gpt-6-luna", kinds: ["vision"], defaultFor: ["vision"] },
  { provider: "openai", id: "gpt-6.1-sol", kinds: ["vision"], defaultFor: [] },
  { provider: "openai", id: "gpt-6-astra", kinds: ["vision"], defaultFor: [] },
  { provider: "openai", id: "gpt-5.6-luna", kinds: ["vision"], defaultFor: [] },
  { provider: "openai", id: "gpt-5.6-terra", kinds: ["vision"], defaultFor: [] },
  { provider: "openai", id: "gpt-5.6-sol", kinds: ["vision"], defaultFor: [] },
];

export const AI_ROLES = [
  // Creates images from a prompt; the fast everyday image model suits it.
  { id: "generate", kind: "image-generate" },
  // Changes an existing image from a prompt and optional mask; the precise editing model suits it.
  { id: "edit", kind: "image-edit" },
  // Judges images against a yes/no criterion. Its checks are not expected to find complex or
  // very small defects, so the fast tier's default model suits it.
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
