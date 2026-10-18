import type { ErrorCode, ErrorEffect } from "./errors.ts";
import type { RefusalCode } from "./refusal.ts";
export type {
  BackplateShape,
  CombineOp,
  DespeckleKeep,
  EncodeFormat,
  FramecheckAxes,
  LayerGravity,
  MaskMethod,
  ResampleKernel,
  VisionDetail,
} from "./enums.ts";
import type {
  BackplateShape,
  CombineOp,
  DespeckleKeep,
  EncodeFormat,
  FramecheckAxes,
  LayerGravity,
  MaskMethod,
  ResampleKernel,
  VisionDetail,
} from "./enums.ts";

/**
 * A profile (format 2): a bundle of arguments a caller keeps in one file and
 * points the SDK at (`loadProfile`). The SDK reads a profile only from a path
 * it is given and never writes one. Format 1 profiles (`provider`, `apiKey`,
 * `apiKeyEnv`, `organization`, `project`) read unchanged.
 */
export interface Profile {
  /** The image provider; `"openai"` is the only one. */
  provider: string;
  /** A stored key, `obf:`-encoded or plain. A profile holding one must be readable by its owner only. */
  apiKey?: string;
  /** The environment variable holding the key, looked up in the map the caller passes to `loadProfile`. */
  apiKeyEnv?: string;
  organization?: string;
  project?: string;
  /** The models folder; `~`, `$VAR` and `%VAR%` expand from the passed map, and a relative path resolves against the profile's folder. */
  modelsDir?: string;
  /** The folder logs are written to when a call asks for a log without naming one; expanded like `modelsDir`. */
  logDir?: string;
  /** Policy defaults below the instance's and the call's. */
  policy?: Policy;
}

/** A profile as `loadProfile` returns it: the key resolved and every path absolute. */
export interface LoadedProfile {
  /** The absolute path the profile was read from. */
  path: string;
  provider: "openai";
  /** The resolved key, or null when the profile supplies none. */
  apiKey: string | null;
  /** Where the key came from: `env:<NAME>`, `profile.apiKey`, or null. */
  apiKeySource: string | null;
  organization?: string;
  project?: string;
  modelsDir?: string;
  logDir?: string;
  policy?: Policy;
}

/** The credentials a paid call uses (internal). */
export interface ResolvedProfile {
  redacted: { provider: string; organization?: string; project?: string };
  apiKey: string;
  /** Where the key came from: "constructor", "env:NAME" or "profile.apiKey". */
  apiKeySource: string;
}

/**
 * The `images.generate` / `images.edit` parameters a policy sets; other fields pass through to
 * OpenAI as given. For a supported model (`src/ai-models.ts`), `quality`, `background`,
 * `output_format`, `output_compression` and `size` are checked against its row before any paid
 * call; any other model id is sent unchecked, with nothing added.
 */
export interface GeneratePolicy {
  model?: string;
  size?: string;
  quality?: string;
  background?: string;
  output_format?: string;
  output_compression?: number;
  n?: number;
  /** Not settable: generate sends moderation "low" for a supported model, none for any other id. */
  moderation?: never;
  [key: string]: unknown;
}

/** As {@link GeneratePolicy}; the edit endpoint takes no moderation. */
export interface EditPolicy {
  model?: string;
  size?: string;
  quality?: string;
  background?: string;
  output_format?: string;
  output_compression?: number;
  n?: number;
  /** Not settable: moderation is not exposed. */
  moderation?: never;
  [key: string]: unknown;
}

export interface VisionPolicy {
  model?: string;
  shrink?: { width: number; height: number };
  /**
   * Sent as chosen; for a supported model `auto` when unset. Any other model id sends it only
   * when set.
   */
  detail?: VisionDetail;
  /**
   * Sent as `reasoning_effort`. For a supported model it is checked against the model's list and
   * defaults to the model's own default; any other model id sends it unchecked, only when set.
   */
  reasoning?: string;
  /** Not settable: the effort is set with `reasoning`. */
  reasoning_effort?: never;
  systemPrompt?: string;
  [key: string]: unknown;
}

/** The `chroma` policy section: defaults for `mask` with `method: "chroma"`, and the backdrop key `generate` asks for and records. */
export interface ChromaPolicy {
  /** Chroma key color, "#rrggbb". Also recorded in the sidecar when `generate` runs. */
  color?: string;
  /** When true, interior key-colored regions are kept opaque. Default false. */
  preserveInterior?: boolean;
  /** Border-sample depth in pixels for `key: "auto"`. */
  borderSample?: number;
  /** Spill ratio at which near-key pixels saturate to α=0. */
  saturationRatio?: number;
}

/** ONNX Runtime tuning for the local models. */
export interface OnnxPolicy {
  /** Intra-op threads per session. Default half the CPU cores, at least one. */
  intraOpThreads?: number;
  /** Execution providers in priority order, e.g. `["coreml", "cpu"]`. Default `["cpu"]`. */
  executionProviders?: string[];
}

/** A per-category network budget override; unset fields keep their defaults. */
export interface NetworkBudgetPolicy {
  timeout?: number;
  maxRetries?: number;
  retryIntervals?: number[];
}

/**
 * How the work is done: typed sections with documented defaults, overridden
 * partially per profile, per instance and per call, the call winning. A list
 * replaces the earlier list whole.
 */
export interface Policy {
  generate?: GeneratePolicy;
  edit?: EditPolicy;
  vision?: VisionPolicy;
  chroma?: ChromaPolicy;
  /** Per-category network budgets. See src/network/defaults.ts. */
  network?: {
    imageGenerate?: NetworkBudgetPolicy;
    imageVision?: NetworkBudgetPolicy;
    imageDownload?: NetworkBudgetPolicy;
    modelDownload?: NetworkBudgetPolicy;
  };
  onnx?: OnnxPolicy;
}

/** One file a paid record describes: its name, the SHA-256 of its bytes, and its format. */
export interface SidecarFileEntry {
  index: number;
  name: string;
  sha256: string;
  format: string;
}

/** Who wrote a format-2 sidecar: this SDK and its version, and the calling app when the caller named one. */
export interface SidecarWriter {
  name: "gptimgsdk";
  version: string;
  app?: { name: string; version: string };
}

export type SidecarKind = "generate" | "edit" | "vision";

/** The common shape of every sidecar as `readSidecar` returns it. */
interface SidecarBase {
  /** The file's format: 1 (and unmarked v0.1.0 files) or 2. */
  formatVersion: 1 | 2;
  /** Null for format 1, which did not record its writer. */
  writer: SidecarWriter | null;
}

/**
 * The request a generate record holds: the parameters sent to the provider as
 * sent (model, size, quality, moderation and the rest), the prompt as sent, the
 * image count, and gptimgsdk's own annotation `chroma.color`, the key colour the
 * policy named, which `mask` and `keycheck` read back.
 */
export interface GenerateRequestRecord {
  prompt: string;
  n: number;
  model?: string;
  chroma?: { color: string };
  [param: string]: unknown;
}

/** An edit's request: as generate's, plus the source image and optional mask by name and SHA-256. */
export interface EditRequestRecord extends GenerateRequestRecord {
  input: string;
  /** Absent only in format-1 records written before digests were recorded. */
  inputSha256?: string;
  mask: string | null;
  maskSha256?: string | null;
}

/** A vision check's request: the parameters sent, the check, and each input by name, SHA-256 and shrink. */
export interface VisionRequestRecord {
  check: string;
  model?: string;
  detail?: string;
  reasoning?: string;
  inputs: Array<{
    name: string;
    /** Absent only in format-1 records written before digests were recorded. */
    sha256?: string;
    shrink: { applied: boolean; originalWidth: number; originalHeight: number; outputWidth: number; outputHeight: number };
  }>;
  [param: string]: unknown;
}

/** The record beside a generated image: the request as sent, the provider's reply without image bytes, and the image. */
export interface GenerateSidecar extends SidecarBase {
  kind: "generate";
  request: GenerateRequestRecord;
  /** The provider's reply as received, with its creation time and token usage; image bytes are nulled. */
  response: Record<string, unknown>;
  files: SidecarFileEntry[];
}

export interface EditSidecar extends SidecarBase {
  kind: "edit";
  request: EditRequestRecord;
  response: Record<string, unknown>;
  files: SidecarFileEntry[];
}

/** The record of a vision check, which produces no image: the request, the verdict and the provider's raw reply. */
export interface VisionSidecar extends SidecarBase {
  kind: "vision";
  request: VisionRequestRecord;
  response: { verdict: VisionVerdict; raw: unknown };
  files: [];
}

export type Sidecar = GenerateSidecar | EditSidecar | VisionSidecar;

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogStage =
  | "resolve"
  | "request"
  | "response"
  | "write"
  | "stats"
  | "retry"
  | "download"
  | "read"
  | "process"
  | "infer"
  | "hash"
  | "cancelled"
  | "error"
  // The logging subsystem reporting on itself (e.g. the session file is unavailable).
  | "log";
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
  | "resize"
  | "encode"
  | "despeckle"
  | "keycheck"
  | "framecheck"
  | "grid"
  | "model"
  | "verify";

export interface LogEntry {
  /** Event instant: UTC ISO-8601 with milliseconds and `Z` (logging-conventions envelope). */
  time: string;
  level: LogLevel;
  /** Short, stable, human-readable description of the event. */
  message: string;
  /** Typed structured fields carried alongside the three envelope keys. */
  verb: LogVerb;
  stage: LogStage;
  data?: Record<string, unknown>;
}

export interface LogHandle {
  /** The log file, or null when the call asked for no log. */
  path: string | null;
  verb: LogVerb;
}

/** Countable work done so far, for a progress bar (`onProgress`). */
export interface ProgressUpdate {
  verb: LogVerb;
  stage: LogStage;
  done: number;
  total: number;
  unit: "bytes" | "tiles" | "inputs" | "renditions" | "passes";
  /** The item the count belongs to when a call works through several: a model's file name while models install or verify. */
  subject?: string;
}

/** How a companion file's publication went, reported on its own (sdk-conventions, *An artifact holds itself*). */
export type FilePublication =
  | { status: "published" }
  | { status: "failed"; code: ErrorCode | RefusalCode; effect: ErrorEffect; message: string };

/** A paid image that was published. Its sidecar is reported separately; the image is kept when the sidecar fails. */
export interface OutputFile {
  index: number;
  path: string;
  sha256: string;
  format: string;
  /** Per-image sidecar: `<image-stem>.json`, the same stem as `path`. */
  sidecarPath: string;
  sidecar: FilePublication;
  /** The record the sidecar holds, also here so a caller keeps it when the sidecar could not be written. */
  record: GenerateSidecar | EditSidecar;
}

/** Item failure codes beyond the error and refusal codes: the provider returned no image for the item. */
export const ITEM_FAILURE_CODES = ["provider.noImage"] as const;

/** A requested image that yielded no published file, with its own code and effect. */
export interface ItemFailure {
  index: number;
  code: (typeof ITEM_FAILURE_CODES)[number] | ErrorCode | RefusalCode;
  /** `unknown`: the paid request had taken effect, and a write may have begun. */
  effect: ErrorEffect;
  message: string;
}

export interface GenerateArgs {
  prompt: string;
  /** Destination for generated images. There is no source folder, so either this or an absolute `outName` is required. */
  outDir?: string;
  /** A bare stem in `outDir`, or an absolute stem that also chooses the folder. */
  outName?: string;
  /** Policy for this call, merged over the instance's and the profile's (last wins). */
  policy?: Policy;
  overwrite?: boolean;
}

export interface GenerateResult {
  status: "completed";
  /** Every image that was published, in index order. */
  files: OutputFile[];
  /** Every requested image that yielded no published file. */
  failures: ItemFailure[];
  /** Earlier-run slot files an overwrite could not remove; empty normally. */
  leftovers: string[];
  logPath: string | null;
}

export interface EditArgs extends Omit<GenerateArgs, "outDir"> {
  in: string;
  /** Defaults beside the input, preserving its supplied path (including symlinks). */
  outDir?: string;
  mask?: string;
}

export type EditResult = GenerateResult;

export interface VisionArgs {
  in: string | string[];
  check: string;
  /** Policy for this call, merged over the instance's and the profile's (last wins). */
  policy?: Policy;
  /** Defaults beside the first input image. */
  outDir?: string;
  outName?: string;
  /** Overwrite an existing sidecar at the resolved stem. Default false. */
  overwrite?: boolean;
}

export interface VisionVerdict {
  ok: boolean;
  score: number;
  reasons: string[];
}

export interface VisionResult extends VisionVerdict {
  status: "completed";
  raw: unknown;
  sidecarPath: string;
  sidecar: FilePublication;
  /** The record the sidecar holds, also here so a caller keeps it when the sidecar could not be written. */
  record: VisionSidecar;
  logPath: string | null;
}

// ----- mask / compose / combine -----

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

export interface MaskArgs extends PngEncodingArgs {
  in: string;
  method?: MaskMethod;
  /**
   * "auto" | "from-sidecar" | "#rrggbb" — chroma-method only. "from-sidecar"
   * reads the generate sidecar beside `in` and refuses one that does not record
   * `in`'s SHA-256 (`sidecar.imageMismatch`).
   */
  key?: string;
  preserveInterior?: boolean;
  borderSample?: number;
  /** Spill ratio at which near-key pixels saturate to α=0 (0..1]. Chroma-method only. */
  saturationRatio?: number;
  /** The models folder for the AI method; default the instance's, then the profile's, then `~/.gptimgsdk/models`. */
  modelsDir?: string;
  /** Policy for this call; the chroma method takes its unset arguments from `chroma`. */
  policy?: Policy;
  outDir?: string;
  outName?: string;
  overwrite?: boolean;
}

export interface MaskResult {
  status: "completed";
  input: string;
  output: string;
  stats: MaskStats;
  logPath: string | null;
}

export interface ComposeArgs extends EncodingArgs {
  in: string;
  mask: string;
  /**
   * "transparent" | "#rrggbb" | "<path-to-image>" — flatten target.
   * Omit for transparent output.
   */
  over?: string;
  /**
   * Remove the named background color from the subject pixels the mask kept.
   * The math dispatches on the key's chromaticity and only one path runs: a
   * chromatic key (R/G/B/C/M/Y) gets spill suppression at every kept pixel and
   * no edge recovery (solving `C = α·F + (1−α)·B` is unstable for chroma/AI-mask
   * alphas and would halo); an achromatic key (gray) instead gets alpha-aware
   * edge recovery at partial-α pixels only. Format: `#rrggbb`.
   */
  removeBleed?: string;
  outDir?: string;
  outName?: string;
  overwrite?: boolean;
}

export interface ComposeResult {
  status: "completed";
  input: string;
  mask: string;
  output: string;
  width: number;
  height: number;
  over: "transparent" | "color" | "image";
  logPath: string | null;
}

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

export interface TrimArgs extends EncodingArgs {
  in: string;
  /** Margin to re-pad, as a fraction of the longer bbox side. 0..1. Default 0.08. */
  margin?: number;
  /** Extend the shorter axis with transparent pixels to make the output square. */
  square?: boolean;
  outDir?: string;
  outName?: string;
  overwrite?: boolean;
}

export interface TrimResult {
  status: "completed";
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
  logPath: string | null;
}

// ----- backplate -----

export interface BackplateArgs extends EncodingArgs {
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
  /** Required unless outName is an absolute output stem. */
  outDir?: string;
  outName?: string;
  overwrite?: boolean;
}

export interface BackplateResult {
  status: "completed";
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
  logPath: string | null;
}

// ----- layer -----

export interface LayerOffset {
  /**
   * Pixel offset of the top image's top-left corner from the base's top-left.
   * May be negative or run past the base edge — the top bleeds off the canvas
   * and is clipped. Only a placement entirely outside the base is rejected.
   */
  x: number;
  y: number;
}

export interface LayerArgs extends EncodingArgs {
  /** Base RGBA image (the bottom layer, e.g. a backplate). */
  base: string;
  /** Top RGBA image (the foreground, e.g. trimmed content). */
  top: string;
  /**
   * Resize the top image so its longer side equals `scale * min(baseW, baseH)`.
   * Preserves aspect ratio. Omit to keep top at its native size. May exceed 1.0:
   * the top then bleeds beyond the canvas and is clipped to the base (full-bleed
   * content). The output is always the base's size.
   */
  scale?: number;
  /** Placement anchor. Default "center". Ignored when `topOffset` is given. */
  gravity?: LayerGravity;
  /** Explicit pixel offset of the top image (overrides `gravity`). May bleed off-canvas; see {@link LayerOffset}. */
  topOffset?: LayerOffset;
  outDir?: string;
  outName?: string;
  overwrite?: boolean;
}

export interface LayerResult {
  status: "completed";
  base: string;
  top: string;
  output: string;
  /** Final output size (= base size; layer never changes the canvas). */
  width: number;
  height: number;
  /** Scaled size of the top image (after `scale`, if any), before any clip to the base. */
  topWidth: number;
  topHeight: number;
  /** Resolved placement. One of `gravity` or `topOffset` is null. */
  gravity: LayerGravity | null;
  topOffset: LayerOffset | null;
  logPath: string | null;
}

// ----- shadow -----

export interface ShadowOffset {
  /** Pixel displacement of the shadow from the subject. May be negative. */
  x: number;
  y: number;
}

export interface ShadowArgs extends EncodingArgs {
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
  overwrite?: boolean;
}

export interface ShadowResult {
  status: "completed";
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
  logPath: string | null;
}

// ----- resample (shared by upscale + resize) -----

// ----- upscale -----

export interface UpscaleArgs extends EncodingArgs {
  /** Input RGBA image (e.g. a trimmed content cutout). */
  in: string;
  /** Final output longer-side length in px (aspect preserved). Default 1024. */
  toSize?: number;
  /** Resampling kernel for the resize after the model's ×4. Default "lanczos3". */
  kernel?: ResampleKernel;
  /**
   * Max model-input edge per pass — the memory knob. Default 256 (about 3 GB
   * peak); memory grows with the tile's area, so 512 needs about four times as
   * much. A tile too large for the machine fails as `memory.exhausted`.
   */
  tile?: number;
  /** The models folder for this call; default the instance's, then the profile's, then `~/.gptimgsdk/models`. */
  modelsDir?: string;
  /** Policy for this call; upscale reads only `onnx`. */
  policy?: Policy;
  outDir?: string;
  outName?: string;
  overwrite?: boolean;
}

export interface UpscaleResult {
  status: "completed";
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
  logPath: string | null;
}

// ----- resize -----

export interface ResizeArgs extends EncodingArgs {
  /** Input image (any format sharp reads); alpha preserved if present. */
  in: string;
  /** Output longer-side length in px (aspect preserved). Required. */
  toSize: number;
  /** Resampling kernel. Default "lanczos3". */
  kernel?: ResampleKernel;
  outDir?: string;
  outName?: string;
  overwrite?: boolean;
}

export interface ResizeResult {
  status: "completed";
  input: string;
  output: string;
  sourceWidth: number;
  sourceHeight: number;
  /** Final output size (longer side = toSize, aspect preserved). */
  width: number;
  height: number;
  toSize: number;
  kernel: ResampleKernel;
  logPath: string | null;
}

// ----- encode -----

/**
 * The lossless PNG options of the encoder. A verb whose format is fixed to PNG takes only
 * these; each is passed to the encoder only when set, so its own default applies otherwise.
 */
export interface PngEncodingArgs {
  /** Deflate level, an integer 0..9. Unset, the encoder's default applies. */
  compressionLevel?: number;
  /**
   * Choose each row's filter by trial, which compresses gradients and textures better at some
   * cost in time. Unset, the encoder's default applies.
   */
  adaptiveFiltering?: boolean;
}

/**
 * How a verb that writes an image encodes it. Each option is passed to the encoder only when
 * set, so the encoder's own defaults apply otherwise: with none set the file is a PNG at the
 * encoder's defaults. A PNG-only option with `format: "webp"`, or a WebP-only option with PNG,
 * is `args.invalid`.
 */
export interface EncodingArgs extends PngEncodingArgs {
  /** Output encoding; the output extension follows it. PNG is always lossless. Default "png". */
  format?: EncodeFormat;
  /** WebP only: lossy quality, an integer 1..100. Unset, the encoder's default applies. Not with `lossless`. */
  quality?: number;
  /**
   * WebP only: encode losslessly. Every visible pixel is kept exactly; the colour under a
   * fully transparent pixel is not. Default false.
   */
  lossless?: boolean;
  /**
   * WebP only: keep the colour of sharp coloured edges that lossy chroma subsampling would
   * smear. Unset, the encoder's default applies.
   */
  smartSubsample?: boolean;
  /**
   * Require every pixel of the written image to be fully opaque and write no alpha channel,
   * for a surface that shows transparency as black (an Apple touch icon). A translucent pixel
   * is refused, never flattened. Default false: the alpha channel is kept.
   */
  opaque?: boolean;
}

export interface EncodeArgs extends EncodingArgs {
  /** Input image (any format sharp reads). Its pixels are written as they are. */
  in: string;
  /** Output encoding. Required. */
  format: EncodeFormat;
  outDir?: string;
  outName?: string;
  overwrite?: boolean;
}

export interface EncodeResult {
  status: "completed";
  input: string;
  output: string;
  format: EncodeFormat;
  /** The image's size, which encoding never changes. */
  width: number;
  height: number;
  /** Whether the output carries an alpha channel. */
  alpha: boolean;
  /** Whether the output is lossless: every PNG, and WebP with `lossless`. */
  lossless: boolean;
  /** Input file size in bytes. */
  sourceBytes: number;
  /** Output file size in bytes. */
  bytes: number;
  logPath: string | null;
}

// ----- icon -----

export interface IconArgs extends PngEncodingArgs {
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
  overwrite?: boolean;
}

export interface IconResult {
  status: "completed";
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
  logPath: string | null;
}

export interface CombineArgs extends PngEncodingArgs {
  op: CombineOp;
  /** 1 input for `invert`/`feather`, 2 inputs for the binary ops. */
  inputs: string[];
  /** Feather radius (number of 3×3 box-blur passes). Ignored for other ops. */
  radius?: number;
  outDir?: string;
  outName?: string;
  overwrite?: boolean;
}

export interface CombineResult {
  status: "completed";
  inputs: string[];
  output: string;
  width: number;
  height: number;
  op: CombineOp;
  logPath: string | null;
}

// ----- despeckle -----

export interface DespeckleArgs extends EncodingArgs {
  /** Input RGBA cutout whose alpha matte is cleaned. */
  in: string;
  /** Keep alpha ≥ threshold; zero below (the floor, and the component on-level). Integer 0..255. Default 5. */
  threshold?: number;
  /** Remove connected components smaller than this many pixels. 0 = remove none. Integer ≥ 0. Default 0. */
  minArea?: number;
  /** Pixel neighbourhood for components: 4 or 8. Default 8. */
  connectivity?: number;
  /** "all" = remove components below minArea; "largest" = keep only the biggest. Default "all". */
  keep?: DespeckleKeep;
  outDir?: string;
  outName?: string;
  overwrite?: boolean;
}

export interface DespeckleResult {
  status: "completed";
  input: string;
  output: string;
  /** Resolved threshold (floor / component on-level). */
  threshold: number;
  /** Resolved minimum component area in pixels. */
  minArea: number;
  /** Resolved connectivity (4 or 8). */
  connectivity: number;
  keep: DespeckleKeep;
  /** Pixels zeroed by the floor (had 0 < alpha < threshold). */
  flooredPixels: number;
  /** Connected components found over the alpha ≥ threshold pixels. */
  components: number;
  /** Components removed (below minArea, or all-but-largest). */
  removedComponents: number;
  /** Pixels zeroed by component removal. */
  removedPixels: number;
  /** Any-alpha bbox before the op; null if the input was fully transparent. */
  bboxBefore: AlphaBBox | null;
  /** Any-alpha bbox after the op; null if nothing remains. */
  bboxAfter: AlphaBBox | null;
  width: number;
  height: number;
  logPath: string | null;
}

// ----- keycheck -----

/** A "clean" cutout has residue within the verdict thresholds; "residue" exceeds them. */
export const KEY_RESIDUE_VERDICTS = ["clean", "residue"] as const;
export type KeyResidueVerdict = (typeof KEY_RESIDUE_VERDICTS)[number];

/**
 * Deterministic key-residue analysis of a keyed cutout — *did background removal
 * succeed?* A read-only diagnostic: it never edits the asset (its only possible
 * output is an optional debug heatmap). A pixel counts as residue when it ships
 * (alpha > 0) and its color is biased toward the key hue — within `hueTolerance`
 * degrees of the key's hue AND at least `minSaturation`/`minValue` (the gates
 * exclude near-gray and near-black pixels whose hue is numerically unstable, so
 * a legitimately key-*adjacent* subject color is not flagged). Residue on the
 * alpha edge is fringe; residue in the interior is a missed background patch.
 */
export interface KeycheckArgs extends EncodingArgs {
  /** Keyed RGBA cutout to inspect (typically post mask → compose). */
  in: string;
  /** Key color to scan for: "from-sidecar" (read the generate sidecar beside `in`) or "#rrggbb". Required — keycheck does not guess a key. */
  key: string;
  /** Max hue distance (degrees, 0..180) from the key hue for a pixel to count as residue. Default 20. */
  hueTolerance?: number;
  /** Min HSV saturation (0..1] for a pixel to count as residue — gates out near-gray pixels. Default 0.35. */
  minSaturation?: number;
  /** Min HSV value (0..1] for a pixel to count as residue — gates out near-black pixels. Default 0.25. */
  minValue?: number;
  /** Verdict is "residue" once edgeResidueFraction exceeds this. Default 0.02. */
  maxEdgeResidueFraction?: number;
  /** Verdict is "residue" once interiorResiduePixels exceeds this. Default 0. */
  maxInteriorResiduePixels?: number;
  /** Also write a debug heatmap PNG marking residue pixels. Default false. */
  heatmap?: boolean;
  outDir?: string;
  outName?: string;
  overwrite?: boolean;
}

export interface KeycheckResult {
  status: "completed";
  input: string;
  /** Resolved key color, "#rrggbb". */
  key: string;
  /** Where the key came from ("sidecar" or "explicit"; never "auto"). */
  keySource: ChromaKeySource;
  width: number;
  height: number;
  /** Pixels that ship (alpha > 0). */
  presentPixels: number;
  /** Present pixels with ≥1 fully-transparent in-bounds 4-neighbour (the alpha edge ring). */
  edgePixels: number;
  /** All present pixels flagged as key residue. */
  residuePixels: number;
  /** Residue pixels on the alpha edge (key fringe). */
  edgeResiduePixels: number;
  /** Residue pixels not on the alpha edge (a missed background patch). */
  interiorResiduePixels: number;
  /** edgeResiduePixels / edgePixels (0 when there is no edge). */
  edgeResidueFraction: number;
  /** residuePixels / presentPixels (0 when nothing is present). */
  residueFraction: number;
  /** Bounding box of all residue pixels; null when there is none. */
  worstBBox: AlphaBBox | null;
  /** Resolved hue tolerance (degrees). */
  hueTolerance: number;
  /** Resolved saturation gate. */
  minSaturation: number;
  /** Resolved value gate. */
  minValue: number;
  verdict: KeyResidueVerdict;
  /** Debug heatmap path when `heatmap` was set, else null. */
  heatmapPath: string | null;
  logPath: string | null;
}

// ----- framecheck -----

/** Transparent margins from each canvas edge to the subject box, in pixels. */
export interface FrameMargins {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Whether the subject box touches each canvas border (zero margin → clipped/full-bleed). */
export interface FrameEdgeContact {
  left: boolean;
  right: boolean;
  top: boolean;
  bottom: boolean;
}

/** "centered" when the enforced margin-pair asymmetries are within tolerance; "offset" otherwise. */
export const FRAMECHECK_VERDICTS = ["centered", "offset"] as const;
export type FramecheckVerdict = (typeof FRAMECHECK_VERDICTS)[number];

/** Margin-pair asymmetries in pixels. The verdict is computed from these. */
export interface FrameDeltas {
  /** |left − right|. */
  horizontal: number;
  /** |top − bottom|. */
  vertical: number;
}

/**
 * Deterministic, read-only alpha-coverage geometry — *where does the opaque
 * content sit inside its canvas?* The geometry counterpart to `keycheck`: one
 * scan of the alpha channel, no pixels changed, no file written. It answers the
 * centering / margin-lock / edge-clipping questions the stamp and icon workflows
 * pose on every mechanically-placed output; it reads no colour (that is
 * `keycheck`), re-pads nothing (that is `trim`), and judges no visual balance
 * (that is `vision`).
 */
export interface FramecheckArgs {
  /** RGBA image to inspect. */
  in: string;
  /** Alpha at/above which a pixel is the opaque "solid" body. Integer 1..255 (1 = any shipping pixel). Default 128. */
  threshold?: number;
  /** Max margin-pair asymmetry, in pixels, for the verdict to be "centered". Default 2. */
  tolerance?: number;
  /** Which axis/axes the verdict enforces. Both deltas are always reported. Default "horizontal". */
  axes?: FramecheckAxes;
}

export interface FramecheckResult {
  status: "completed";
  input: string;
  width: number;
  height: number;
  /** Resolved solid-body alpha threshold. */
  threshold: number;
  /** Resolved verdict tolerance, in pixels. */
  tolerance: number;
  /** Resolved verdict axes. */
  axes: FramecheckAxes;
  /** No pixel ships (the image is fully transparent). */
  empty: boolean;
  /** Tightest box of any shipping pixel (alpha > 0) — includes a soft shadow/feather. Null when empty. */
  anyBBox: AlphaBBox | null;
  /** Tightest box of the opaque body (alpha ≥ threshold). Null when nothing is solid. */
  solidBBox: AlphaBBox | null;
  /** Margins of the subject box (solid, or any-alpha when no solid pixels exist). Null when empty. */
  margins: FrameMargins | null;
  deltas: FrameDeltas | null;
  edgeContact: FrameEdgeContact | null;
  /** "centered" when the enforced axes are within tolerance (empty is vacuously centered). */
  verdict: FramecheckVerdict;
  logPath: string | null;
}

// ----- grid -----

export interface GridArgs extends EncodingArgs {
  /** Images to tile, in order. At least one. */
  inputs: string[];
  /** Number of columns. Default ceil(sqrt(count of readable inputs)). */
  cols?: number;
  /** Square cell side in pixels; each image is contain-fit into it. Default 256. */
  cell?: number;
  /** Gap between cells (and the outer border) in pixels. Default 16. */
  gap?: number;
  /** Sheet background: "transparent" or "#rrggbb". Default "transparent". */
  background?: string;
  outDir?: string;
  outName?: string;
  overwrite?: boolean;
}

/** A `grid` input that could not be read; nothing was written for it. */
export interface GridSkip {
  input: string;
  code: ErrorCode;
  effect: "none";
  message: string;
}

export interface GridResult {
  status: "completed";
  output: string;
  /** Inputs supplied. */
  count: number;
  /** Tiles actually drawn (readable inputs). */
  placed: number;
  /** Inputs that could not be read, in order, each with the error naming why — skipped, unless none could be read. */
  skipped: GridSkip[];
  cols: number;
  rows: number;
  /** Resolved cell side (px). */
  cell: number;
  /** Resolved gap (px). */
  gap: number;
  width: number;
  height: number;
  logPath: string | null;
}

// ----- model management -----

/** One model file as installed (or found already cached) by `model install`. */
export interface InstalledModel {
  key: string;
  name: string;
  path: string;
  /** True when `force` re-downloaded over an installed file. */
  forced: boolean;
}

/** Result of `model install` and `installAll`: every model the call installed. */
export interface ModelInstallResult {
  status: "completed";
  installed: InstalledModel[];
  logPath: string | null;
}

/** One known model and its cache state, from `model list`. */
export interface ModelListEntry {
  key: string;
  name: string;
  path: string;
  /** True when the installed file is complete; a verb can use it. */
  cached: boolean;
  /** The size of the file on disk, when there is one. */
  sizeBytes?: number;
  /** The size an install downloads, for a free-space check before it starts. */
  downloadBytes: number | null;
}

/** Result of `model list`: every known model and whether it is cached. */
export interface ModelListResult {
  status: "completed";
  models: ModelListEntry[];
}

/**
 * Integrity status of one cached model file, from `model verify`.
 *   "ok"           — present and its sha256 matches the pinned value.
 *   "mismatch"     — present but the wrong hash (corrupt or swapped on disk).
 *   "missing"      — not cached.
 *   "unverifiable" — the registry entry pins no sha256 (ad-hoc entries only).
 */
export const MODEL_INTEGRITIES = ["ok", "mismatch", "missing", "unverifiable"] as const;
export type ModelIntegrity = (typeof MODEL_INTEGRITIES)[number];

/** One model's integrity result, from `model verify`. */
export interface ModelVerifyEntry {
  key: string;
  name: string;
  path: string;
  integrity: ModelIntegrity;
  /** The pinned hash expected — absent only for an entry with no pinned sha256. */
  expectedSha256?: string;
  /** The hash computed from the cached file — absent when missing or unverifiable. */
  actualSha256?: string;
}

/** Result of `model verify`: the on-disk integrity of every known model. */
export interface ModelVerifyResult {
  status: "completed";
  models: ModelVerifyEntry[];
  /** JSONL log for this verification session. */
  logPath: string | null;
}

/** What `verify` can find wrong with a published paid image and its sidecar. */
export const VERIFY_FINDING_CODES = [
  "sidecar.missing",
  "sidecar.malformed",
  "sidecar.newerFormat",
  "sidecar.hashMismatch",
  "sidecar.nameMismatch",
  "image.undecodable",
  "image.formatMismatch",
] as const;
export type VerifyFindingCode = (typeof VERIFY_FINDING_CODES)[number];

export interface VerifyFinding {
  code: VerifyFindingCode;
  message: string;
}

export interface VerifyArgs {
  /** The published image (absolute); its sidecar is `<stem>.json` beside it. */
  in: string;
}

export interface VerifyResult {
  status: "completed";
  input: string;
  sidecarPath: string;
  /** True when there are no findings. */
  ok: boolean;
  findings: VerifyFinding[];
  /** The sidecar as read, or null when it is missing or unreadable. */
  record: Sidecar | null;
  logPath: string | null;
}

export interface GptImgOptions {
  /** A profile from `loadProfile`; every option below overrides its value. */
  profile?: LoadedProfile;
  /** The API key, overriding the profile's. Needed only by paid verbs. */
  apiKey?: string;
  organization?: string;
  project?: string;
  /** The models folder (absolute). Default the profile's, then `~/.gptimgsdk/models`. */
  modelsDir?: string;
  /** The folder calls log into when they ask for no other (absolute). No default: without one, nothing is logged. */
  logDir?: string;
  /** Policy merged over the profile's; each call's policy merges over this. */
  policy?: Policy;
  /** The calling app, recorded in each sidecar's `writer` beside the SDK's own name and version. */
  app?: { name: string; version: string };
}

// The dependency-free tables a renderer needs beside these types, so the
// `gptimgsdk/types` entry alone can map codes to its own text and fill its
// pickers without loading sharp, ONNX Runtime or the OpenAI client.
export { ERROR_CODES, ERROR_EFFECTS, ERROR_KINDS, isGptImgErrorData } from "./errors.ts";
export type { ErrorCode, ErrorDetails, ErrorEffect, ErrorKind, GptImgErrorData, SerializedCause } from "./errors.ts";
export { REFUSAL_CODES } from "./refusal.ts";
export type { Refusal, RefusalCode, RefusedResult } from "./refusal.ts";
export {
  BACKPLATE_SHAPES,
  COMBINE_OPS,
  DESPECKLE_KEEP,
  ENCODE_FORMATS,
  FRAMECHECK_AXES,
  LAYER_GRAVITIES,
  MASK_METHODS,
  RESAMPLE_KERNELS,
  VISION_DETAILS,
} from "./enums.ts";
export { MODEL_LINEUP, SUPPORTED_MODELS, defaultModelFor, modelsFor } from "./ai-models.ts";
export type {
  AiKind,
  AiProvider,
  ImageCapabilities,
  ImageModelRow,
  ImageSizeRule,
  ModelRow,
  SupportedModel,
  VisionModelRow,
} from "./ai-models.ts";
