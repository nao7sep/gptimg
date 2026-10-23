import type { ErrorCode, ErrorEffect, GptImgErrorData } from "./errors.ts";
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
 * The `images.generate` / `images.edit` parameters a policy sets; any other field is refused
 * as `policy.invalid`, never sent. For a supported model, `quality`, `background`,
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
}

/** The `chroma` policy section: defaults for `mask` with `method: "chroma"`, and the backdrop key `generate` asks for and records. */
export interface ChromaPolicy {
  /** Chroma key color, "#rrggbb". Also recorded in the sidecar when `generate` runs. */
  color?: string;
  /** When true, interior key-colored regions are kept opaque. Default `CHROMA_DEFAULTS.preserveInterior`. */
  preserveInterior?: boolean;
  /** Border-sample depth in pixels for `key: "auto"`. */
  borderSample?: number;
  /** Spill ratio at which near-key pixels saturate to α=0. */
  saturationRatio?: number;
}

/**
 * The `chat` policy section: the assistant that leads a conversation and the
 * image tool it calls. For a supported assistant model the effort is checked
 * against its row; for a supported image model the tool's values are checked
 * against that row, as `generate`'s are.
 */
export interface ChatPolicy {
  /** The assistant model; default the chat role's. */
  model?: string;
  /** Its reasoning effort; default the row's own. */
  reasoning?: string;
  /** Instructions for the assistant, replacing the built-in ones. */
  instructions?: string;
  /** The image tool's model; default the edit role's. */
  imageModel?: string;
  size?: string;
  quality?: string;
  background?: string;
  output_format?: string;
  output_compression?: number;
  /**
   * How many drafts of each image to show while it is drawn, 0 to 3 (default
   * 0). Above 0 the response is streamed and each draft reaches the call's
   * `onPartialImage`; drafts are not saved.
   */
  partial_images?: number;
}

/** A draft of an image while the image tool draws it. */
export interface PartialImage {
  /** Which image of the turn it belongs to, 0 for the first, in the order the image tool began them. */
  image: number;
  /** Which draft of that image, from 0. */
  index: number;
  data: Uint8Array;
  format: string;
}

/** ONNX Runtime tuning for the local models. */
export interface OnnxPolicy {
  /** Intra-op threads per session. Default half the CPU cores, at least one. */
  intraOpThreads?: number;
  /** Execution providers in priority order, e.g. `["coreml", "cpu"]`. Default `ONNX_DEFAULTS.executionProviders`. */
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
 * partially per instance and per call, the call winning. A list
 * replaces the earlier list whole.
 */
export interface Policy {
  generate?: GeneratePolicy;
  edit?: EditPolicy;
  vision?: VisionPolicy;
  chat?: ChatPolicy;
  chroma?: ChromaPolicy;
  /** Per-category network budgets; each unset field keeps its default (`NETWORK_DEFAULTS`). */
  network?: {
    imageGenerate?: NetworkBudgetPolicy;
    chat?: NetworkBudgetPolicy;
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

export type SidecarKind = "generate" | "edit" | "vision" | "chat";

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

/**
 * The request a chat turn's record holds: the assistant and image-tool
 * parameters as sent, the user's message, its attached images by name and
 * SHA-256, how the conversation was carried (`previousResponseId` when the
 * turn continued OpenAI's copy, `historyTurns` when it resent the earlier
 * turns), and no image bytes.
 */
export interface ChatRequestRecord {
  model: string;
  reasoning?: string;
  instructions: string;
  tool: Record<string, unknown>;
  message: string;
  images: Array<{ name: string; sha256: string }>;
  /** The mask applied to the first image, when one was sent. */
  mask?: { name: string; sha256: string };
  previousResponseId: string | null;
  historyTurns: number;
  [param: string]: unknown;
}

/**
 * The record of a chat turn: beside each image the turn produced, or alone as
 * `<stem>.json` when the turn produced none, since its answer was paid for too.
 */
export interface ChatSidecar extends SidecarBase {
  kind: "chat";
  request: ChatRequestRecord;
  /** The provider's response as received, with its reply, usage and image calls; image bytes are nulled. */
  response: Record<string, unknown>;
  files: SidecarFileEntry[];
}

export type Sidecar = GenerateSidecar | EditSidecar | VisionSidecar | ChatSidecar;

export type EventLevel = "debug" | "info" | "warn" | "error";
export type EventStage =
  | "startup"
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
  | "error";
export type VerbName =
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
  | "verify"
  | "inspect"
  | "chat";

/** One provider request attempt, as each attempt event records it (data-lifecycle-conventions: one record per attempt). */
export interface AttemptFields {
  /** The network budget the attempt ran under. */
  budget: string;
  attempt: number;
  maxRetries: number;
  durationMs: number;
  /** The request as sent, with image bytes replaced and credentials masked. */
  request?: Record<string, unknown>;
}

/** A failed attempt: its status, the error, and the provider's own answer when one came back. */
export interface FailedAttemptFields extends AttemptFields {
  status: number | null;
  error: { name: string; message: string; code: string | null };
  response?: Record<string, unknown>;
}

/**
 * The typed body of every event, named by `event`. A caller stores events as
 * received; open-ended content (a provider's request and response, a verb's
 * resolved settings and stats) sits in named object fields.
 */
export type SdkEventBody =
  // Once per instance, on the first call that passes `onEvent`.
  | {
      event: "sdk.start";
      version: string;
      node: string;
      platform: string;
      arch: string;
      modelsDir: string;
      debug: boolean;
      app: { name: string; version: string } | null;
      /** Whether a key was given; never the key. */
      apiKey: boolean;
      organization: string | null;
      project: string | null;
      policy: Policy;
    }
  | { event: "verb.start"; input: string | string[] | null; output: string | null; settings: Record<string, unknown> }
  | { event: "verb.done"; output: string | null; stats: Record<string, unknown> }
  | { event: "verb.refused"; code: RefusalCode; subject: string | null }
  | { event: "verb.failed"; error: GptImgErrorData; thrown: Record<string, unknown> }
  | { event: "verb.cancelled"; error: GptImgErrorData }
  | { event: "provider.call"; operation: "generate" | "edit" | "vision" | "chat"; model: string | null; settings: Record<string, unknown> }
  | { event: "provider.returned"; operation: "generate" | "edit" | "vision" | "chat"; summary: Record<string, unknown> }
  | ({ event: "attempt.succeeded"; response: Record<string, unknown> } & AttemptFields)
  | ({ event: "attempt.failed" } & FailedAttemptFields)
  | ({ event: "attempt.retrying"; waitMs: number; retryAfterHeader: boolean; retryAfterCapped: boolean } & FailedAttemptFields)
  | ({ event: "attempt.cancelled" } & AttemptFields)
  | { event: "image.short"; requested: number; returned: number }
  | { event: "image.missing"; index: number; error: string | null }
  | { event: "image.undecodable"; index: number; error: string }
  | { event: "image.unpublished"; index: number; error: string }
  | { event: "image.published"; index: number; name: string; sha256: string; format: string; sidecar: string | null }
  | { event: "sidecar.published"; path: string }
  | { event: "sidecar.unpublished"; index: number | null; path: string; error: string }
  | { event: "slots.leftover"; leftovers: string[] }
  | { event: "vision.input"; name: string; shrink: Record<string, unknown> }
  | { event: "vision.refusal"; code: RefusalCode; request: Record<string, unknown>; response: unknown }
  | { event: "vision.noVerdict"; request: Record<string, unknown>; response: unknown; error: { name: string; code: unknown; message: string } }
  | { event: "chat.resend"; previousResponseId: string }
  | { event: "chat.historyImage"; path: string; width: number; height: number; format: string }
  | { event: "chat.historyImageSkipped"; path: string; error: string }
  | { event: "model.download.needed"; name: string }
  | { event: "model.download.start"; name: string }
  | { event: "model.download.done"; name: string; bytes: number }
  | { event: "model.infer.start"; model: string; settings: Record<string, unknown> }
  | { event: "model.infer.done"; model: string; stats: Record<string, unknown> }
  | { event: "model.verify.start"; key: string; name: string; sizeBytes: number | null }
  | { event: "model.verify.done"; key: string; name: string; integrity: string };

export type SdkEventName = SdkEventBody["event"];

/**
 * A complete event record (sdk-conventions, *Logging*): the time, level,
 * stage, the verb it belongs to, a short English message fixed per event name,
 * and the typed fields of its body. The SDK writes no log; a caller stores
 * these as received.
 */
export type SdkEvent = {
  /** UTC ISO-8601 with milliseconds and `Z`. */
  time: string;
  level: EventLevel;
  stage: EventStage;
  verb: VerbName;
  message: string;
} & SdkEventBody;

/** Countable work done so far, for a progress bar (`onProgress`). */
export interface ProgressUpdate {
  verb: VerbName;
  stage: EventStage;
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
  record: GenerateSidecar | EditSidecar | ChatSidecar;
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
  /** The provider's documented reason, safe to present beneath the consumer's own copy, when it declined the item. */
  safeReason?: string | null;
}

export interface GenerateArgs {
  prompt: string;
  /** Destination for generated images. There is no source folder, so either this or an absolute `outName` is required. */
  outDir?: string;
  /** A bare stem in `outDir`, or an absolute stem that also chooses the folder. */
  outName?: string;
  /** Policy for this call, merged over the instance's (last wins). */
  policy?: Policy;
  overwrite?: boolean;
}

/**
 * The tokens a paid call spent, read from the provider's response: the model's
 * input and output, and in a chat turn the image tool's own. A field the
 * response did not report is absent; the whole is null when it reported no usage.
 */
export interface Usage {
  input: number;
  output: number;
  /** The image tool's input tokens in a chat turn. */
  imageInput?: number;
  /** The image tool's output tokens in a chat turn. */
  imageOutput?: number;
}

export interface GenerateResult {
  status: "completed";
  /** Every image that was published, in index order. */
  files: OutputFile[];
  /** Every requested image that yielded no published file. */
  failures: ItemFailure[];
  /** Earlier-run slot files an overwrite could not remove; empty normally. */
  leftovers: string[];
  /**
   * The provider's response as recorded in each sidecar (image data removed,
   * credentials masked), with its token `usage`. Present on every completed
   * call, also when no image was published, so what the call spent is never lost.
   */
  response: Record<string, unknown>;
  /** The tokens the call spent, from `response`. */
  usage: Usage | null;
  /** The provider's id for the response; null for the images endpoint, which gives none. */
  responseId: string | null;
}

export interface EditArgs extends Omit<GenerateArgs, "outDir"> {
  in: string;
  /** Defaults beside the input, preserving its supplied path (including symlinks). */
  outDir?: string;
  mask?: string;
}

export type EditResult = GenerateResult;

export interface VisionArgs {
  /** The images to judge together (absolute), at least one. */
  inputs: string[];
  check: string;
  /** Policy for this call, merged over the instance's (last wins). */
  policy?: Policy;
  /** Defaults beside the first input. */
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
  /** The provider's response as recorded (credentials masked). */
  raw: unknown;
  /** The tokens the call spent. */
  usage: Usage | null;
  /** The provider's id for the response. */
  responseId: string | null;
  sidecarPath: string;
  sidecar: FilePublication;
  /** The record the sidecar holds, also here so a caller keeps it when the sidecar could not be written. */
  record: VisionSidecar;
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

/**
 * What a local model's output depends on, so a different output from the same
 * input can be explained: the model's pin, the runtime and its version, and how
 * it ran. A model's output is not promised to match across runtimes or machines.
 */
export interface InferenceRecord {
  model: { key: string; name: string; sha256: string | null };
  runtime: { name: "onnxruntime-node"; version: string };
  /** The execution providers asked for, in priority order. */
  executionProviders: string[];
  intraOpThreads: number;
}

export interface AiMaskStats {
  method: "ai";
  model: "birefnet";
  removedPixels: number;
  removedFraction: number;
  width: number;
  height: number;
  inference: InferenceRecord;
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
  /** The models folder for the AI method; default the instance's, then `~/.gptimgsdk/models`. */
  modelsDir?: string;
  /** Policy for this call; the chroma method takes its unset arguments from `chroma`. */
  policy?: Policy;
  outDir?: string;
  outName?: string;
  /**
   * The exact output file (absolute), instead of `outDir` and `outName`; its extension
   * must be the format's. With `overwrite` it replaces a file there whole.
   */
  out?: string;
  overwrite?: boolean;
}

export interface MaskResult {
  status: "completed";
  input: string;
  output: string;
  stats: MaskStats;
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
  /**
   * The exact output file (absolute), instead of `outDir` and `outName`; its extension
   * must be the format's. With `overwrite` it replaces a file there whole.
   */
  out?: string;
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
  /** Margin to re-pad, as a fraction of the longer bbox side. 0..1. Default `TRIM_DEFAULTS.margin`. */
  margin?: number;
  /** Extend the shorter axis with transparent pixels to make the output square. */
  square?: boolean;
  outDir?: string;
  outName?: string;
  /**
   * The exact output file (absolute), instead of `outDir` and `outName`; its extension
   * must be the format's. With `overwrite` it replaces a file there whole.
   */
  out?: string;
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
}

// ----- backplate -----

export interface BackplateArgs extends EncodingArgs {
  /** Output PNG side length in pixels. Default `BACKPLATE_DEFAULTS.size`. */
  size?: number;
  /** Content side length as a fraction of `size` (the squircle occupies this). Default `BACKPLATE_DEFAULTS.content`. */
  content?: number;
  /** Corner radius as a fraction of the content side (0..0.5). Default `BACKPLATE_DEFAULTS.radius`. */
  radius?: number;
  /** Gradient start color, "#rrggbb". Required. */
  from: string;
  /** Gradient end color, "#rrggbb". Required. */
  to: string;
  /** CSS-style gradient angle in degrees (0 = bottom→top, 90 = left→right, 180 = top→bottom). Default `BACKPLATE_DEFAULTS.angle`. */
  angle?: number;
  /** Corner shape. Default `BACKPLATE_DEFAULTS.shape`. */
  shape?: BackplateShape;
  /** Required unless outName is an absolute output stem. */
  outDir?: string;
  outName?: string;
  /**
   * The exact output file (absolute), instead of `outDir` and `outName`; its extension
   * must be the format's. With `overwrite` it replaces a file there whole.
   */
  out?: string;
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
  /** Placement anchor. Default `LAYER_DEFAULTS.gravity`. Ignored when `topOffset` is given. */
  gravity?: LayerGravity;
  /** Explicit pixel offset of the top image (overrides `gravity`). May bleed off-canvas; see {@link LayerOffset}. */
  topOffset?: LayerOffset;
  outDir?: string;
  outName?: string;
  /**
   * The exact output file (absolute), instead of `outDir` and `outName`; its extension
   * must be the format's. With `overwrite` it replaces a file there whole.
   */
  out?: string;
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
  /** Gaussian blur sigma for the shadow edge, in pixels. Default `SHADOW_DEFAULTS.blur`. */
  blur?: number;
  /** Shadow displacement from the subject. Default `SHADOW_DEFAULTS.offset`. */
  offset?: ShadowOffset;
  /** Shadow color, "#rrggbb". Default `SHADOW_DEFAULTS.color`. */
  color?: string;
  /** Peak shadow opacity, (0, 1]. Default `SHADOW_DEFAULTS.opacity`. */
  opacity?: number;
  /** Grow the shadow shape outward by this many pixels before blurring. Default `SHADOW_DEFAULTS.spread`. */
  spread?: number;
  /**
   * Keep the output canvas at the input's dimensions, clipping any shadow that
   * falls outside. Default `SHADOW_DEFAULTS.keepCanvas`: the canvas grows so the shadow is never cut.
   */
  keepCanvas?: boolean;
  outDir?: string;
  outName?: string;
  /**
   * The exact output file (absolute), instead of `outDir` and `outName`; its extension
   * must be the format's. With `overwrite` it replaces a file there whole.
   */
  out?: string;
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
}

// ----- resample (shared by upscale + resize) -----

// ----- upscale -----

export interface UpscaleArgs extends EncodingArgs {
  /** Input RGBA image (e.g. a trimmed content cutout). */
  in: string;
  /** Final output longer-side length in px (aspect preserved). Default `UPSCALE_DEFAULTS.toSize`. */
  toSize?: number;
  /** Resampling kernel for the resize after the model's ×4. Default `UPSCALE_DEFAULTS.kernel`. */
  kernel?: ResampleKernel;
  /**
   * Max model-input edge per pass — the memory knob. Default `UPSCALE_DEFAULTS.tile`,
   * which peaks at about 3 GB; memory grows with the tile's area, so twice the
   * edge needs about four times as much. A tile too large for the machine fails as `memory.exhausted`.
   */
  tile?: number;
  /** The models folder for this call; default the instance's, then `~/.gptimgsdk/models`. */
  modelsDir?: string;
  /** Policy for this call; upscale reads only `onnx`. */
  policy?: Policy;
  outDir?: string;
  outName?: string;
  /**
   * The exact output file (absolute), instead of `outDir` and `outName`; its extension
   * must be the format's. With `overwrite` it replaces a file there whole.
   */
  out?: string;
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
  inference: InferenceRecord;
}

// ----- resize -----

export interface ResizeArgs extends EncodingArgs {
  /** Input image (any format sharp reads); alpha preserved if present. */
  in: string;
  /** Output longer-side length in px (aspect preserved). Required. */
  toSize: number;
  /** Resampling kernel. Default `RESIZE_DEFAULTS.kernel`. */
  kernel?: ResampleKernel;
  outDir?: string;
  outName?: string;
  /**
   * The exact output file (absolute), instead of `outDir` and `outName`; its extension
   * must be the format's. With `overwrite` it replaces a file there whole.
   */
  out?: string;
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
  /** Output encoding; the output extension follows it (`.jpg` for JPEG). PNG is always lossless. Default `ENCODING_DEFAULTS.format`. */
  format?: EncodeFormat;
  /** WebP and JPEG: lossy quality, an integer 1..100. Unset, the encoder's default applies. Not with `lossless`. */
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
  /**
   * Fill transparency with this colour (`#rrggbb`) and write no alpha channel: the caller
   * chooses the colour, so the SDK never invents one. JPEG holds no transparency, so a JPEG
   * of an image with translucent pixels needs it; without it that image is refused as
   * `image.notOpaque`. Not with `opaque`, which refuses transparency instead of filling it.
   */
  background?: string;
}

export interface EncodeArgs extends EncodingArgs {
  /** Input image (any format sharp reads). Its pixels are written as they are. */
  in: string;
  /** Output encoding. Required. */
  format: EncodeFormat;
  outDir?: string;
  outName?: string;
  /**
   * The exact output file (absolute), instead of `outDir` and `outName`; its extension
   * must be the format's. With `overwrite` it replaces a file there whole.
   */
  out?: string;
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
}

// ----- icon -----

export interface IconArgs extends PngEncodingArgs {
  /**
   * Square master PNG, at least 1024×1024 — e.g. the vision-approved icon from
   * the backplate/layer pipeline. Smaller sizes are downsampled from it.
   */
  in: string;
  /** The outputs' stem: a bare name in `outDir`, or an absolute stem that also chooses the folder. Default `ICON_DEFAULTS.name` (`<name>.icns`, `.ico`, `.png`). */
  outName?: string;
  /** Also emit the loose sized-PNG set `<name>-<size>.png` (16…1024). Default `ICON_DEFAULTS.pngs`. */
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
  /** The master's dimensions. */
  sourceWidth: number;
  sourceHeight: number;
}

export interface CombineArgs extends PngEncodingArgs {
  op: CombineOp;
  /** 1 input for `invert`/`feather`, 2 inputs for the binary ops. */
  inputs: string[];
  /** Feather radius (number of 3×3 box-blur passes). Ignored for other ops. */
  radius?: number;
  outDir?: string;
  outName?: string;
  /**
   * The exact output file (absolute), instead of `outDir` and `outName`; its extension
   * must be the format's. With `overwrite` it replaces a file there whole.
   */
  out?: string;
  overwrite?: boolean;
}

export interface CombineResult {
  status: "completed";
  inputs: string[];
  output: string;
  width: number;
  height: number;
  op: CombineOp;
}

// ----- despeckle -----

export interface DespeckleArgs extends EncodingArgs {
  /** Input RGBA cutout whose alpha matte is cleaned. */
  in: string;
  /** Keep alpha ≥ threshold; zero below (the floor, and the component on-level). Integer 0..255. Default `DESPECKLE_DEFAULTS.threshold`. */
  threshold?: number;
  /** Remove connected components smaller than this many pixels. 0 = remove none. Integer ≥ 0. Default `DESPECKLE_DEFAULTS.minArea`. */
  minArea?: number;
  /** Pixel neighbourhood for components: 4 or 8. Default `DESPECKLE_DEFAULTS.connectivity`. */
  connectivity?: number;
  /** "all" = remove components below minArea; "largest" = keep only the biggest. Default `DESPECKLE_DEFAULTS.keep`. */
  keep?: DespeckleKeep;
  outDir?: string;
  outName?: string;
  /**
   * The exact output file (absolute), instead of `outDir` and `outName`; its extension
   * must be the format's. With `overwrite` it replaces a file there whole.
   */
  out?: string;
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
  /** Max hue distance (degrees, 0..180) from the key hue for a pixel to count as residue. Default `KEYCHECK_DEFAULTS.hueTolerance`. */
  hueTolerance?: number;
  /** Min HSV saturation (0..1] for a pixel to count as residue — gates out near-gray pixels. Default `KEYCHECK_DEFAULTS.minSaturation`. */
  minSaturation?: number;
  /** Min HSV value (0..1] for a pixel to count as residue — gates out near-black pixels. Default `KEYCHECK_DEFAULTS.minValue`. */
  minValue?: number;
  /** Verdict is "residue" once edgeResidueFraction exceeds this. Default `KEYCHECK_DEFAULTS.maxEdgeResidueFraction`. */
  maxEdgeResidueFraction?: number;
  /** Verdict is "residue" once interiorResiduePixels exceeds this. Default `KEYCHECK_DEFAULTS.maxInteriorResiduePixels`. */
  maxInteriorResiduePixels?: number;
  /** Also write a debug heatmap PNG marking residue pixels. Default false. */
  heatmap?: boolean;
  outDir?: string;
  outName?: string;
  /**
   * The exact output file (absolute), instead of `outDir` and `outName`; its extension
   * must be the format's. With `overwrite` it replaces a file there whole.
   */
  out?: string;
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
  /** Alpha at/above which a pixel is the opaque "solid" body. Integer 1..255 (1 = any shipping pixel). Default `FRAMECHECK_DEFAULTS.threshold`. */
  threshold?: number;
  /** Max margin-pair asymmetry, in pixels, for the verdict to be "centered". Default `FRAMECHECK_DEFAULTS.tolerance`. */
  tolerance?: number;
  /** Which axis/axes the verdict enforces. Both deltas are always reported. Default `FRAMECHECK_DEFAULTS.axes`. */
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
}

// ----- grid -----

export interface GridArgs extends EncodingArgs {
  /** Images to tile, in order. At least one. */
  inputs: string[];
  /** Number of columns. Default ceil(sqrt(count of readable inputs)). */
  cols?: number;
  /** Square cell side in pixels; each image is contain-fit into it. Default `GRID_DEFAULTS.cell`. */
  cell?: number;
  /** Gap between cells (and the outer border) in pixels. Default `GRID_DEFAULTS.gap`. */
  gap?: number;
  /** Sheet background: "transparent" or "#rrggbb". Default `GRID_DEFAULTS.background`. */
  background?: string;
  outDir?: string;
  outName?: string;
  /**
   * The exact output file (absolute), instead of `outDir` and `outName`; its extension
   * must be the format's. With `overwrite` it replaces a file there whole.
   */
  out?: string;
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

/** A model `installAll` could not install, with its own code and effect; the others still installed. */
export interface ModelInstallFailure {
  key: string;
  name: string;
  code: ErrorCode;
  /** `unknown` when a file may have been written. */
  effect: ErrorEffect;
  message: string;
}

/**
 * Result of `model install` and `installAll`: every model the call installed,
 * and for `installAll` every one it could not. `install` of one model throws
 * when that model fails, since nothing else was asked for.
 */
export interface ModelInstallResult {
  status: "completed";
  installed: InstalledModel[];
  failures: ModelInstallFailure[];
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
  downloadBytes: number;
}

/** Result of `model.release()`: how many loaded models were freed. */
export interface ModelReleaseResult {
  status: "completed";
  released: number;
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
 */
export const MODEL_INTEGRITIES = ["ok", "mismatch", "missing"] as const;
export type ModelIntegrity = (typeof MODEL_INTEGRITIES)[number];

/** One model's integrity result, from `model verify`. */
export interface ModelVerifyEntry {
  key: string;
  name: string;
  path: string;
  integrity: ModelIntegrity;
  /** The pinned hash expected. */
  expectedSha256: string;
  /** The hash computed from the cached file — absent when missing. */
  actualSha256?: string;
}

/** Result of `model verify`: the on-disk integrity of every known model. */
export interface ModelVerifyResult {
  status: "completed";
  models: ModelVerifyEntry[];
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
}

/** One earlier turn of a conversation as the caller holds it; images by absolute path. */
export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  images?: string[];
}

export interface ChatArgs {
  /** The user's message. */
  message: string;
  /** Images attached to the message, by absolute path. */
  images?: string[];
  /**
   * A PNG the size of the first image in `images` whose transparent pixels
   * mark where that image may change, by absolute path (OpenAI's
   * `input_image_mask`). Needs at least one image.
   */
  mask?: string;
  /**
   * Every earlier turn, oldest first. Sent when there is no `previousResponseId`,
   * or when OpenAI no longer holds that response; the SDK keeps no conversation.
   */
  history?: ChatTurn[];
  /** The previous turn's `responseId`, so only this turn is sent while OpenAI holds the conversation. */
  previousResponseId?: string;
  /** Where the turn's images and records are written (absolute); required, since a chat has no source folder. */
  outDir: string;
  /** The stem of the turn's files: a bare name in `outDir`. */
  outName?: string;
  overwrite?: boolean;
  /** Policy for this call; chat reads `chat` and `network`. */
  policy?: Policy;
}

export interface ChatResult {
  status: "completed";
  /** The assistant's reply; empty when it only produced images. */
  text: string;
  /** Every image the turn produced and published, in order. */
  files: OutputFile[];
  /** Every image the turn produced that yielded no published file. */
  failures: ItemFailure[];
  leftovers: string[];
  /** The turn's record when it produced no image (`<stem>.json`); null when its images carry it or it could not be written. */
  recordPath: string | null;
  /**
   * Whether that record was written, when the turn produced no image; null when
   * its images carry it, each file saying so in its own `sidecar`. The record
   * stays in `response` either way.
   */
  recordPublication: FilePublication | null;
  /** Pass as the next turn's `previousResponseId`. */
  responseId: string;
  /** "chain": OpenAI's copy carried the conversation; "resent": it was gone and the history was resent; null: no previous response was given. */
  resumed: "chain" | "resent" | null;
  /** Why the provider stopped early (e.g. "max_output_tokens"), with what it produced kept; null when it finished. */
  incomplete: string | null;
  /** The provider's response as recorded (image data removed, credentials masked), with its token `usage`. */
  response: Record<string, unknown>;
  /** The tokens the turn spent, the image tool's included. */
  usage: Usage | null;
}

export interface InspectArgs {
  /** The image (absolute). A sidecar beside it is `<stem>.json`. */
  in: string;
}

/** The sidecar beside an inspected image, read but not checked against the image (`verify` does that). */
export type InspectRecord =
  | {
      path: string;
      status: "readable";
      kind: SidecarKind;
      formatVersion: number;
      /** Who wrote it; null for format 1 and unmarked v0.1.0 sidecars. */
      writer: SidecarWriter | null;
      /** The chroma key the paid request recorded, which `mask` and `keycheck` read with `key: "from-sidecar"`. */
      chromaKey: string | null;
    }
  | { path: string; status: "unreadable"; code: ErrorCode; message: string };

/**
 * What an image is, for a consumer choosing what to run on it. Dimensions are
 * as stored, which is what every verb works on; `orientation` reports an EXIF
 * rotation a viewer would apply.
 */
export interface InspectResult {
  status: "completed";
  input: string;
  fileBytes: number;
  /** Detected from the bytes, as sharp names it: "png", "jpeg", "webp", … */
  format: string;
  /** False when the file's extension names another format than its bytes hold, e.g. JPEG data in a `.png`. */
  extensionMatches: boolean;
  width: number;
  height: number;
  channels: number;
  /** The file has an alpha channel. */
  hasAlpha: boolean;
  /** No alpha channel, or every pixel fully opaque. Only an image with an alpha channel is decoded to tell. */
  opaque: boolean;
  /** Bits per channel sample. */
  bitDepth: number;
  /** sharp's colour-space name: "srgb", "cmyk", "b-w", … */
  colorSpace: string;
  /** Pixels per inch, when the file records it. */
  density: number | null;
  /** The EXIF orientation (1–8), when the file records one. */
  orientation: number | null;
  /** More than 1 for an animated or multi-page file. */
  pages: number;
  /** The sidecar beside the image, or null when there is none. */
  record: InspectRecord | null;
}

export interface GptImgOptions {
  /** The API key. Needed only by paid verbs; the SDK reads no environment variable for it. */
  apiKey?: string;
  organization?: string;
  project?: string;
  /** The OpenAI API's base URL (`https://…`); default `OPENAI_BASE_URL`, OpenAI's own. A proxy or another endpoint that speaks OpenAI's API goes here. */
  baseURL?: string;
  /** The models folder (absolute). Default `~/.gptimgsdk/models`. */
  modelsDir?: string;
  /** Hand debug events to `onEvent` too. Default false. */
  debug?: boolean;
  /** Policy merged over the built-in defaults; each call's policy merges over this. */
  policy?: Policy;
  /** The calling app, recorded in each sidecar's `writer` beside the SDK's own name and version. */
  app?: { name: string; version: string };
}

// The dependency-free tables a renderer needs beside these types, so the
// `gptimgsdk/types` entry alone can map codes to its own text and fill its
// pickers without loading sharp, ONNX Runtime or the OpenAI client.
export { ERROR_CODES, ERROR_EFFECTS, ERROR_KINDS, isGptImgErrorData } from "./errors.ts";
export * from "./defaults.ts";
export { OPENAI_BASE_URL } from "./providers/openai/endpoint.ts";
export type { ErrorCode, ErrorDetails, ErrorEffect, ErrorKind, GptImgErrorData, GptImgErrorOptions, SerializedCause } from "./errors.ts";
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
