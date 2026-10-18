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
import { installModelsImpl, listModelsImpl, verifyModelsImpl } from "./verbs/model.ts";
import { MODELS } from "./local/models/registry.ts";
import type { ModelInstallOptions, ModelVerifyOptions } from "./verbs/model.ts";
import type { VerbCallOptions } from "./verbs/options.ts";
import { encodeImpl } from "./verbs/encode.ts";
import { resizeImpl } from "./verbs/resize.ts";
import { trimImpl } from "./verbs/trim.ts";
import { upscaleImpl } from "./verbs/upscale.ts";
import { visionImpl } from "./verbs/vision.ts";
import { verifyImpl } from "./verbs/verify.ts";
import type { ModelKey } from "./local/models/registry.ts";
import type { ModelInstallResult, ModelListResult, ModelVerifyResult } from "./types.ts";

export type { VerbCallOptions } from "./verbs/options.ts";
export type { ModelInstallOptions, ModelVerifyOptions } from "./verbs/model.ts";

export class GptImg {
  readonly #ctx: SdkContext;

  readonly model = {
    /** Install one model into the models folder; nothing installs implicitly. */
    install: (key: ModelKey, opts?: ModelInstallOptions): Promise<ModelInstallResult> =>
      installModelsImpl(this.#ctx, [key], opts),
    /** Install every model the SDK uses. */
    installAll: (opts?: ModelInstallOptions): Promise<ModelInstallResult> =>
      installModelsImpl(this.#ctx, Object.keys(MODELS) as ModelKey[], opts),
    list: (opts?: { modelsDir?: string }): ModelListResult => listModelsImpl(this.#ctx, opts),
    verify: (opts?: ModelVerifyOptions): Promise<ModelVerifyResult> =>
      verifyModelsImpl(this.#ctx, opts),
  };

  /**
   * Nothing is required: local verbs need no key, models or log. Paid verbs
   * need a key (`apiKey` or a profile that supplies one); models default to
   * `~/.gptimgsdk/models`; nothing is logged unless a call or `logDir` asks.
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

  grid(args: GridArgs, opts?: VerbCallOptions): Promise<GridResult | RefusedResult> {
    return gridImpl(this.#ctx, args, opts);
  }
}
