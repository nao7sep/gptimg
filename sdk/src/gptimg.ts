import { createContext, type SdkContext } from "./context.ts";
import type { RefusedResult } from "./refusal.ts";
import type {
  BackplateArgs,
  BackplateResult,
  CombineArgs,
  CombineResult,
  ComposeArgs,
  ComposeResult,
  DespeckleArgs,
  DespeckleResult,
  EditArgs,
  EditResult,
  EncodeArgs,
  EncodeResult,
  FramecheckArgs,
  FramecheckResult,
  GenerateArgs,
  GenerateResult,
  GptImgOptions,
  GridArgs,
  GridResult,
  IconArgs,
  IconResult,
  KeycheckArgs,
  KeycheckResult,
  LayerArgs,
  LayerResult,
  MaskArgs,
  MaskResult,
  ResizeArgs,
  ResizeResult,
  ShadowArgs,
  ShadowResult,
  TrimArgs,
  TrimResult,
  UpscaleArgs,
  UpscaleResult,
  VisionArgs,
  VisionResult,
  VerifyArgs,
  InspectArgs,
  InspectResult,
  ChatArgs,
  ChatResult,
  VerifyResult,
} from "./types.ts";
import { backplateImpl } from "./verbs/backplate.ts";
import { combineImpl } from "./verbs/combine.ts";
import { composeImpl } from "./verbs/compose.ts";
import { despeckleImpl } from "./verbs/despeckle.ts";
import { editImpl } from "./verbs/edit.ts";
import { framecheckImpl } from "./verbs/framecheck.ts";
import { generateImpl } from "./verbs/generate.ts";
import { gridImpl } from "./verbs/grid.ts";
import { iconImpl } from "./verbs/icon.ts";
import { keycheckImpl } from "./verbs/keycheck.ts";
import { layerImpl } from "./verbs/layer.ts";
import { maskImpl } from "./verbs/mask.ts";
import { shadowImpl } from "./verbs/shadow.ts";
import { installAllModelsImpl, installModelImpl, listModelsImpl, releaseModelsImpl, verifyModelsImpl } from "./verbs/model.ts";
import type { ModelInstallAllArgs, ModelInstallArgs, ModelListArgs, ModelReleaseArgs, ModelVerifyArgs } from "./verbs/model.ts";
import type { VerbCallOptions } from "./verbs/options.ts";
import { encodeImpl } from "./verbs/encode.ts";
import { resizeImpl } from "./verbs/resize.ts";
import { trimImpl } from "./verbs/trim.ts";
import { upscaleImpl } from "./verbs/upscale.ts";
import { visionImpl } from "./verbs/vision.ts";
import { verifyImpl } from "./verbs/verify.ts";
import { inspectImpl } from "./verbs/inspect.ts";
import { chatImpl } from "./verbs/chat.ts";
import type { ModelInstallResult, ModelListResult, ModelReleaseResult, ModelVerifyResult } from "./types.ts";

export type { VerbCallOptions } from "./verbs/options.ts";
export type { ModelInstallAllArgs, ModelInstallArgs, ModelListArgs, ModelReleaseArgs, ModelVerifyArgs } from "./verbs/model.ts";

export class GptImg {
  readonly #ctx: SdkContext;

  readonly model = {
    /** Install one model into the models folder; nothing installs implicitly. */
    install: (args: ModelInstallArgs, opts?: VerbCallOptions): Promise<ModelInstallResult> => installModelImpl(this.#ctx, args, opts),
    /** Install every model the SDK uses. */
    installAll: (args?: ModelInstallAllArgs, opts?: VerbCallOptions): Promise<ModelInstallResult> =>
      installAllModelsImpl(this.#ctx, args, opts),
    /** Which models are installed in the models folder, by a cheap presence check. */
    list: (args?: ModelListArgs, opts?: VerbCallOptions): Promise<ModelListResult> => listModelsImpl(this.#ctx, args, opts),
    /** Re-hash every installed model against its pin. */
    verify: (args?: ModelVerifyArgs, opts?: VerbCallOptions): Promise<ModelVerifyResult> => verifyModelsImpl(this.#ctx, args, opts),
    /**
     * Free the loaded models' memory once any inference in flight finishes. Loaded models are
     * shared by every instance in the process; the next call that needs one loads it again.
     */
    release: (args?: ModelReleaseArgs, opts?: VerbCallOptions): Promise<ModelReleaseResult> => releaseModelsImpl(this.#ctx, args, opts),
  };

  /**
   * Nothing is required: local verbs need no key or models. Paid verbs
   * need `apiKey`; models default to
   * `~/.gptimgsdk/models`; the SDK writes no log, and each call's events go to its `onEvent`.
   * The constructor touches no disk and reads nothing ambient.
   */
  constructor(opts: GptImgOptions = {}) {
    this.#ctx = createContext(opts);
  }

  generate(args: GenerateArgs, opts?: VerbCallOptions): Promise<GenerateResult | RefusedResult> {
    return generateImpl(this.#ctx, args, opts);
  }

  edit(args: EditArgs, opts?: VerbCallOptions): Promise<EditResult | RefusedResult> {
    return editImpl(this.#ctx, args, opts);
  }

  vision(args: VisionArgs, opts?: VerbCallOptions): Promise<VisionResult | RefusedResult> {
    return visionImpl(this.#ctx, args, opts);
  }

  mask(args: MaskArgs, opts?: VerbCallOptions): Promise<MaskResult | RefusedResult> {
    return maskImpl(this.#ctx, args, opts);
  }

  compose(args: ComposeArgs, opts?: VerbCallOptions): Promise<ComposeResult | RefusedResult> {
    return composeImpl(this.#ctx, args, opts);
  }

  combine(args: CombineArgs, opts?: VerbCallOptions): Promise<CombineResult | RefusedResult> {
    return combineImpl(this.#ctx, args, opts);
  }

  despeckle(args: DespeckleArgs, opts?: VerbCallOptions): Promise<DespeckleResult | RefusedResult> {
    return despeckleImpl(this.#ctx, args, opts);
  }

  keycheck(args: KeycheckArgs, opts?: VerbCallOptions): Promise<KeycheckResult | RefusedResult> {
    return keycheckImpl(this.#ctx, args, opts);
  }

  framecheck(args: FramecheckArgs, opts?: VerbCallOptions): Promise<FramecheckResult | RefusedResult> {
    return framecheckImpl(this.#ctx, args, opts);
  }

  trim(args: TrimArgs, opts?: VerbCallOptions): Promise<TrimResult | RefusedResult> {
    return trimImpl(this.#ctx, args, opts);
  }

  backplate(args: BackplateArgs, opts?: VerbCallOptions): Promise<BackplateResult | RefusedResult> {
    return backplateImpl(this.#ctx, args, opts);
  }

  layer(args: LayerArgs, opts?: VerbCallOptions): Promise<LayerResult | RefusedResult> {
    return layerImpl(this.#ctx, args, opts);
  }

  shadow(args: ShadowArgs, opts?: VerbCallOptions): Promise<ShadowResult | RefusedResult> {
    return shadowImpl(this.#ctx, args, opts);
  }

  icon(args: IconArgs, opts?: VerbCallOptions): Promise<IconResult | RefusedResult> {
    return iconImpl(this.#ctx, args, opts);
  }

  upscale(args: UpscaleArgs, opts?: VerbCallOptions): Promise<UpscaleResult | RefusedResult> {
    return upscaleImpl(this.#ctx, args, opts);
  }

  resize(args: ResizeArgs, opts?: VerbCallOptions): Promise<ResizeResult | RefusedResult> {
    return resizeImpl(this.#ctx, args, opts);
  }

  encode(args: EncodeArgs, opts?: VerbCallOptions): Promise<EncodeResult | RefusedResult> {
    return encodeImpl(this.#ctx, args, opts);
  }

  /** Check a published paid image against its sidecar before relying on it. */
  verify(args: VerifyArgs, opts?: VerbCallOptions): Promise<VerifyResult | RefusedResult> {
    return verifyImpl(this.#ctx, args, opts);
  }

  inspect(args: InspectArgs, opts?: VerbCallOptions): Promise<InspectResult | RefusedResult> {
    return inspectImpl(this.#ctx, args, opts);
  }

  /**
   * One turn of a conversation, for an app that holds conversations: the
   * caller keeps the conversation and passes it with each turn, and the SDK
   * sends that turn and publishes its images with their records, keeping
   * nothing between turns. A script that makes or changes images uses
   * `generate` and `edit`.
   */
  chat(args: ChatArgs, opts?: VerbCallOptions): Promise<ChatResult | RefusedResult> {
    return chatImpl(this.#ctx, args, opts);
  }

  grid(args: GridArgs, opts?: VerbCallOptions): Promise<GridResult | RefusedResult> {
    return gridImpl(this.#ctx, args, opts);
  }
}
