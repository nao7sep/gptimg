export interface Profile {
  provider: string;
  model?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  baseURL?: string;
  /** Per-category network budgets. See src/network/defaults.ts. */
  network?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ResolvedProfile {
  /** Original profile fields excluding secret-bearing keys. Safe to log/serialize. */
  redacted: Omit<Profile, "apiKey" | "apiKeyEnv">;
  /** Resolved API key value. NEVER log or serialize. */
  apiKey: string;
  /** Where the key came from: "env:NAME" or "profile.apiKey". */
  apiKeySource: string;
}

export interface ChromaKeyHint {
  color: string;
}

export interface GenerateRecipe {
  size?: string;
  quality?: string;
  n?: number;
  chromaKey?: ChromaKeyHint | null;
  [key: string]: unknown;
}

export interface EditRecipe {
  size?: string;
  [key: string]: unknown;
}

export interface VisionRecipe {
  shrink?: { width: number; height: number };
  [key: string]: unknown;
}

export interface Recipe {
  generate?: GenerateRecipe;
  edit?: EditRecipe;
  vision?: VisionRecipe;
  /** Per-category network budgets. See src/network/defaults.ts. */
  network?: Record<string, unknown>;
}

export type RecipeVerb = "generate" | "edit" | "vision";

export interface SidecarFileEntry {
  index: number;
  name: string;
  sha256: string;
  format: string;
}

export interface Sidecar {
  request: Record<string, unknown>;
  response: unknown;
  files: SidecarFileEntry[];
}

export type LogLevel = "info" | "warn" | "error";
export type LogStage =
  | "resolve"
  | "request"
  | "response"
  | "write"
  | "stats"
  | "retry"
  | "cancelled"
  | "error";
export type LogVerb = "generate" | "edit" | "vision" | "chroma" | "inspect";

export interface LogEntry {
  ts: string;
  verb: LogVerb;
  level: LogLevel;
  stage: LogStage;
  msg: string;
  data?: Record<string, unknown>;
}

export interface LogHandle {
  path: string;
  verb: LogVerb;
}

export interface OutputFile {
  index: number;
  path: string;
  sha256: string;
  format: string;
}

export interface GenerateArgs {
  prompt: string;
  outDir?: string;
  outName?: string;
  profile?: string;
  recipe?: string;
  log?: string;
  set?: string[];
  patch?: string;
  overwrite?: boolean;
}

export interface GenerateResult {
  files: OutputFile[];
  sidecarPath: string;
  logPath: string;
  partial: boolean;
}

export interface EditArgs extends GenerateArgs {
  in: string;
  mask?: string;
}

export type EditResult = GenerateResult;

export interface VisionArgs {
  in: string | string[];
  check: string;
  profile?: string;
  recipe?: string;
  log?: string;
  set?: string[];
  patch?: string;
  outDir?: string;
  outName?: string;
}

export interface VisionVerdict {
  ok: boolean;
  score: number;
  reasons: string[];
}

export interface VisionResult extends VisionVerdict {
  raw: unknown;
  sidecarPath: string;
  logPath: string;
}

export type ChromaMode = "outer" | "all";
export type ChromaMetric = "lab_de76" | "ycbcr";
export type ChromaKeySource = "auto" | "sidecar" | "explicit";

export interface ChromaRegionSummary {
  area: number;
  meanConfidence: number;
  touchesBorder: boolean;
}

export interface ChromaStats {
  key: string;
  keySource: ChromaKeySource;
  mode: ChromaMode;
  removedPixels: number;
  removedFraction: number;
  regionsRemoved: ChromaRegionSummary[];
  meanConfidence: number;
  noKeyDetected: boolean;
  subjectKeyCollisionRisk: boolean;
  bgModel: {
    meanLab: [number, number, number];
    covEigs: [number, number, number];
  };
}

export interface ChromaEdgeBand {
  dilate: number;
  erode: number;
}

export interface ChromaArgs {
  in: string;
  mode?: ChromaMode;
  /** "auto" | "from-sidecar" | "#rrggbb" */
  key?: string;
  innerThreshold?: number;
  outerThreshold?: number;
  metric?: ChromaMetric;
  borderSample?: number;
  edgeBand?: ChromaEdgeBand;
  despill?: boolean;
  fillHoles?: boolean;
  strictConfidence?: number;
  outDir?: string;
  outName?: string;
  /** Mask filename, or `false` to disable mask output. */
  maskName?: string | false;
  verify?: string;
  verifyThreshold?: number;
  log?: string;
  overwrite?: boolean;
}

export interface ChromaResult {
  input: string;
  outputs: {
    image: string;
    mask: string | null;
  };
  stats: ChromaStats;
  verify?: VisionResult;
  logPath: string;
}

export type InspectArgs = Pick<
  ChromaArgs,
  | "in"
  | "mode"
  | "key"
  | "innerThreshold"
  | "outerThreshold"
  | "metric"
  | "borderSample"
  | "edgeBand"
  | "strictConfidence"
  | "log"
>;

export interface InspectResult {
  input: string;
  stats: ChromaStats;
  logPath: string;
}

export interface GptImgOptions {
  profileDir?: string;
  logDir?: string;
}
