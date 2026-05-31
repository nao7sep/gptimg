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
  | "combine"
  | "trim"
  | "backplate"
  | "layer"
  | "shadow"
  | "icon"
  | "upscale"
  | "resize";

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
  /** Overwrite an existing sidecar at the resolved stem. Default false. */
  overwrite?: boolean;
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

// ----- trim -----

/** The tightest rect of non-transparent (alpha > 0) pixels in an RGBA image. */
export interface AlphaBBox {
  /** Top-left x in source coordinates. */
  x: number;
  /** Top-left y in source coordinates. */
  y: number;
  width: number;
  height: number;
}

export interface TrimArgs {
  in: string;
  /** Margin to re-pad, as a fraction of the longer bbox side. 0..1. Default 0.08. */
  margin?: number;
  /** Extend the shorter axis with transparent pixels to make the output square. */
  square?: boolean;
  outDir?: string;
  outName?: string;
  log?: string;
  overwrite?: boolean;
}

export interface TrimResult {
  input: string;
  output: string;
  /** The detected alpha bounding box in the source image. */
  bbox: AlphaBBox;
  /** The resolved margin fraction. */
  margin: number;
  /** Margin in pixels (round(margin * max(bbox.width, bbox.height))). */
  marginPx: number;
  /** Final output width (bbox.width + 2*marginPx, possibly extended for --square). */
  width: number;
  /** Final output height. */
  height: number;
  square: boolean;
  logPath: string;
}

// ----- backplate -----

/**
 * Corner shape for the squircle backplate.
 * - "rect": circular-arc rounded corners (standard SVG rounded rect).
 * - "squircle": quarter-superellipse corners (smoother continuous curvature,
 *   closer to the macOS dock icon shape).
 */
export type BackplateShape = "rect" | "squircle";

export interface BackplateArgs {
  /** Output PNG side length in pixels. Default 1024. */
  size?: number;
  /** Content side length as a fraction of `size` (the squircle occupies this). Default 0.80. */
  content?: number;
  /** Corner radius as a fraction of the content side (0..0.5). Default 0.225. */
  radius?: number;
  /** Gradient start color, "#rrggbb". Required. */
  from: string;
  /** Gradient end color, "#rrggbb". Required. */
  to: string;
  /** CSS-style gradient angle in degrees (0 = bottom→top, 90 = left→right, 180 = top→bottom). Default 135. */
  angle?: number;
  /** Corner shape. Default "rect". */
  shape?: BackplateShape;
  outDir?: string;
  outName?: string;
  log?: string;
  overwrite?: boolean;
}

export interface BackplateResult {
  output: string;
  size: number;
  /** Resolved content side as a fraction of `size`. */
  content: number;
  /** Resolved corner radius as a fraction of the content side. */
  radius: number;
  shape: BackplateShape;
  /** Resolved gradient start color, "#rrggbb". */
  from: string;
  /** Resolved gradient end color, "#rrggbb". */
  to: string;
  angle: number;
  logPath: string;
}

// ----- layer -----

/**
 * Where to anchor the top image on the base when no explicit pixel offset is
 * given. Matches sharp's compass directions.
 */
export type LayerGravity =
  | "center"
  | "north"
  | "south"
  | "east"
  | "west"
  | "northeast"
  | "northwest"
  | "southeast"
  | "southwest";

export interface LayerOffset {
  /** Pixel offset of the top image's top-left corner from the base's top-left. */
  x: number;
  y: number;
}

export interface LayerArgs {
  /** Base RGBA image (the bottom layer, e.g. a backplate). */
  base: string;
  /** Top RGBA image (the foreground, e.g. trimmed content). */
  top: string;
  /**
   * Resize the top image so its longer side equals `scale * min(baseW, baseH)`.
   * Preserves aspect ratio. Omit to keep top at its native size.
   */
  scale?: number;
  /** Placement anchor. Default "center". Ignored when `topOffset` is given. */
  gravity?: LayerGravity;
  /** Explicit pixel offset of the top image (overrides `gravity`). */
  topOffset?: LayerOffset;
  outDir?: string;
  outName?: string;
  log?: string;
  overwrite?: boolean;
}

export interface LayerResult {
  base: string;
  top: string;
  output: string;
  /** Final output size (= base size; layer never changes the canvas). */
  width: number;
  height: number;
  /** Size of the top image as composited (after `scale`, if any). */
  topWidth: number;
  topHeight: number;
  /** Resolved placement. One of `gravity` or `topOffset` is null. */
  gravity: LayerGravity | null;
  topOffset: LayerOffset | null;
  logPath: string;
}

// ----- shadow -----

export interface ShadowOffset {
  /** Pixel displacement of the shadow from the subject. May be negative. */
  x: number;
  y: number;
}

export interface ShadowArgs {
  /** RGBA image with transparency; its alpha shape casts the shadow. */
  in: string;
  /** Gaussian blur sigma for the shadow edge, in pixels. Default 12. */
  blur?: number;
  /** Shadow displacement from the subject. Default { x: 0, y: 8 }. */
  offset?: ShadowOffset;
  /** Shadow color, "#rrggbb". Default "#000000". */
  color?: string;
  /** Peak shadow opacity, (0, 1]. Default 0.35. */
  opacity?: number;
  /** Grow the shadow shape outward by this many pixels before blurring. Default 0. */
  spread?: number;
  /**
   * Keep the output canvas at the input's dimensions, clipping any shadow that
   * falls outside. Default false → the canvas grows so the shadow is never cut.
   */
  keepCanvas?: boolean;
  outDir?: string;
  outName?: string;
  log?: string;
  overwrite?: boolean;
}

export interface ShadowResult {
  input: string;
  output: string;
  /** Final canvas size (grown to fit the shadow unless `keepCanvas`). */
  width: number;
  height: number;
  /** Source image dimensions. */
  sourceWidth: number;
  sourceHeight: number;
  blur: number;
  offset: ShadowOffset;
  /** Resolved shadow color, "#rrggbb". */
  color: string;
  opacity: number;
  spread: number;
  keepCanvas: boolean;
  logPath: string;
}

// ----- resample (shared by upscale + resize) -----

/** Resampling kernel for image resize (sharp kernels). */
export type ResampleKernel =
  | "nearest"
  | "cubic"
  | "mitchell"
  | "lanczos2"
  | "lanczos3";

// ----- upscale -----

export interface UpscaleArgs {
  /** Input RGBA image (e.g. a trimmed content cutout). */
  in: string;
  /** Final output longer-side length in px (aspect preserved). Default 1024. */
  toSize?: number;
  /** Resampling kernel for the resize after the model's ×4. Default "lanczos3". */
  kernel?: ResampleKernel;
  /** Max model-input edge per pass — the memory knob. Default 256. */
  tile?: number;
  recipe?: string;
  outDir?: string;
  outName?: string;
  log?: string;
  overwrite?: boolean;
}

export interface UpscaleResult {
  input: string;
  output: string;
  sourceWidth: number;
  sourceHeight: number;
  /** Size after the model's native ×4, before resampling to the target. */
  modelWidth: number;
  modelHeight: number;
  /** Final output size (longer side = toSize, aspect preserved). */
  width: number;
  height: number;
  toSize: number;
  kernel: ResampleKernel;
  /** Resolved tile (model-input edge) used. */
  tile: number;
  /** Number of model passes (tiles) the source was split into. */
  tiles: number;
  logPath: string;
}

// ----- resize -----

export interface ResizeArgs {
  /** Input image (any format sharp reads); alpha preserved if present. */
  in: string;
  /** Output longer-side length in px (aspect preserved). Required. */
  toSize: number;
  /** Resampling kernel. Default "lanczos3". */
  kernel?: ResampleKernel;
  outDir?: string;
  outName?: string;
  log?: string;
  overwrite?: boolean;
}

export interface ResizeResult {
  input: string;
  output: string;
  sourceWidth: number;
  sourceHeight: number;
  /** Final output size (longer side = toSize, aspect preserved). */
  width: number;
  height: number;
  toSize: number;
  kernel: ResampleKernel;
  logPath: string;
}

// ----- icon -----

export interface IconArgs {
  /**
   * Square master PNG, at least 1024×1024 — e.g. the vision-approved icon from
   * the backplate/layer pipeline. Smaller sizes are downsampled from it.
   */
  in: string;
  /** Base filename stem for outputs. Default "icon" → icon.icns/.ico/.png. */
  name?: string;
  /** Also emit the loose sized-PNG set `<name>-<size>.png` (16…1024). Default false. */
  pngs?: boolean;
  /** Output directory. Default: same as `in`. */
  outDir?: string;
  log?: string;
  overwrite?: boolean;
}

export interface IconResult {
  input: string;
  /** Every file written, absolute paths (icns, ico, png, then any sized PNGs). */
  outputs: string[];
  icns: string;
  ico: string;
  png: string;
  /** The sized-PNG set paths. Empty unless `pngs` was set. */
  pngs: string[];
  /** Source master dimensions. */
  width: number;
  height: number;
  logPath: string;
}

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
