export interface Profile {
  provider: string;
  apiKey?: string;
  apiKeyEnv?: string;
  organization?: string;
  project?: string;
}

export interface ResolvedProfile {
  /** Original profile fields excluding secret-bearing keys. Safe to log/serialize. */
  redacted: Omit<Profile, "apiKey" | "apiKeyEnv">;
  /** Resolved API key value. NEVER log or serialize. */
  apiKey: string;
  /** Where the key came from: "env:NAME" or "profile.apiKey". */
  apiKeySource: string;
}

export interface GenerateRecipe {
  model?: string;
  size?: string;
  quality?: string;
  n?: number;
  [key: string]: unknown;
}

export interface EditRecipe {
  model?: string;
  size?: string;
  quality?: string;
  n?: number;
  [key: string]: unknown;
}

export interface VisionRecipe {
  model?: string;
  shrink?: { width: number; height: number };
  detail?: VisionDetail;
  systemPrompt?: string;
  [key: string]: unknown;
}

/** Defaults for `mask --method chroma` and the implicit chroma backdrop record on `generate`. */
export interface MaskRecipe {
  /** Chroma key color, "#rrggbb". Also recorded in the sidecar when `generate` runs. */
  color?: string;
  /** When true, interior key-colored regions are kept opaque. Default false. */
  preserveInterior?: boolean;
  /** Border-sample depth in pixels for `--key auto`. */
  borderSample?: number;
  /** Spill ratio at which near-key pixels saturate to α=0. */
  saturationRatio?: number;
  [key: string]: unknown;
}

/**
 * `chroma` is the historical name; the recipe slot stays under `recipe.chroma`
 * so existing recipe files keep working. `MaskRecipe` is the type alias used
 * by Phase 2 code paths.
 */
export type ChromaRecipe = MaskRecipe;

export interface Recipe {
  generate?: GenerateRecipe;
  edit?: EditRecipe;
  vision?: VisionRecipe;
  chroma?: ChromaRecipe;
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
export type LogVerb =
  | "generate"
  | "edit"
  | "vision"
  | "mask"
  | "compose"
  | "combine";

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
  /** Per-image sidecar: `<image-stem>.json`. Same stem as `path` minus the extension. */
  sidecarPath: string;
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
  overwrite?: boolean;
}

export interface GenerateResult {
  files: OutputFile[];
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
  outDir?: string;
  outName?: string;
}

export type VisionDetail = "low" | "high" | "original" | "auto";

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

// ----- mask / compose / combine -----

export type MaskMethod = "chroma" | "ai";
export type ChromaKeySource = "auto" | "sidecar" | "explicit";

export interface ChromaMaskStats {
  method: "chroma";
  /** Resolved key color as `#rrggbb`. */
  key: string;
  keySource: ChromaKeySource;
  preserveInterior: boolean;
  removedPixels: number;
  removedFraction: number;
  width: number;
  height: number;
}

export interface AiMaskStats {
  method: "ai";
  model: "birefnet";
  removedPixels: number;
  removedFraction: number;
  width: number;
  height: number;
}

export type MaskStats = ChromaMaskStats | AiMaskStats;

export interface MaskArgs {
  in: string;
  method?: MaskMethod;
  /** "auto" | "from-sidecar" | "#rrggbb" — chroma-method only. */
  key?: string;
  preserveInterior?: boolean;
  borderSample?: number;
  /** Spill ratio at which near-key pixels saturate to α=0 (0..1]. Chroma-method only. */
  saturationRatio?: number;
  /** Skip writing the mask; emit stats only. */
  dryRun?: boolean;
  outDir?: string;
  outName?: string;
  recipe?: string;
  log?: string;
  overwrite?: boolean;
}

export interface MaskResult {
  input: string;
  /** Null when dryRun was set. */
  output: string | null;
  stats: MaskStats;
  logPath: string;
}

export interface ComposeArgs {
  in: string;
  mask: string;
  /**
   * "transparent" | "#rrggbb" | "<path-to-image>" — flatten target.
   * Omit for transparent output.
   */
  over?: string;
  /**
   * Remove the named background color from subject pixels. Applies
   * chromatic spill suppression at every kept pixel and alpha-aware edge
   * recovery at partial-α pixels. Achromatic hexes still get edge recovery.
   * Format: `#rrggbb`.
   */
  removeBleed?: string;
  outDir?: string;
  outName?: string;
  log?: string;
  overwrite?: boolean;
}

export interface ComposeResult {
  input: string;
  mask: string;
  output: string;
  width: number;
  height: number;
  over: "transparent" | "color" | "image";
  logPath: string;
}

export type CombineOp = "union" | "intersect" | "subtract" | "invert" | "feather";

export interface CombineArgs {
  op: CombineOp;
  /** 1 input for `invert`/`feather`, 2 inputs for the binary ops. */
  inputs: string[];
  /** Feather radius (number of 3×3 box-blur passes). Ignored for other ops. */
  radius?: number;
  outDir?: string;
  outName?: string;
  log?: string;
  overwrite?: boolean;
}

export interface CombineResult {
  inputs: string[];
  output: string;
  width: number;
  height: number;
  op: CombineOp;
  logPath: string;
}

// ----- model management -----

export interface ModelInstallResult {
  key: string;
  name: string;
  path: string;
  forced: boolean;
}

export interface ModelListEntry {
  key: string;
  name: string;
  path: string;
  cached: boolean;
  sizeBytes?: number;
}

export interface GptImgOptions {
  profileDir?: string;
  logDir?: string;
}
