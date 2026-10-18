import { hash } from "./image/hash.ts";
import { detectFormat } from "./image/detectFormat.ts";
import { shrinkForVision } from "./image/shrinkForVision.ts";
import {
  appendLog,
  closeLog,
  createLogger,
  openLog,
} from "./log/index.ts";
import { loadProfile } from "./profile/load.ts";
import { resolveProfile } from "./profile/resolve.ts";
import { clearApiKey, setApiKey } from "./profile/setApiKey.ts";
import { loadRecipe } from "./recipe/load.ts";
import { mergeRecipes } from "./recipe/merge.ts";
import { readSidecar } from "./sidecar/read.ts";
import { writeSidecar } from "./sidecar/write.ts";
import {
  defaultLogDir,
  defaultProfileDir,
  defaultProfilePath,
  ensureSecureProfileRoot,
  resolveDirOption,
} from "./internal/paths.ts";
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
import {
  installAllModelsImpl,
  installModelImpl,
  listModelsImpl,
  verifyModelsImpl,
} from "./verbs/model.ts";
import type { ModelInstallOptions, ModelVerifyOptions } from "./verbs/model.ts";
import type { VerbCallOptions } from "./verbs/options.ts";
import { encodeImpl } from "./verbs/encode.ts";
import { resizeImpl } from "./verbs/resize.ts";
import { trimImpl } from "./verbs/trim.ts";
import { upscaleImpl } from "./verbs/upscale.ts";
import { visionImpl } from "./verbs/vision.ts";
import type { ModelKey } from "./local/models/registry.ts";
import type { InstalledModel, ModelInstallResult, ModelListResult, ModelVerifyResult } from "./types.ts";

export type { VerbCallOptions } from "./verbs/options.ts";
export type { ModelInstallOptions, ModelVerifyOptions } from "./verbs/model.ts";

export class GptImg {
  readonly profileDir: string;
  readonly logDir: string;

  readonly profile: {
    load: typeof loadProfile;
    resolve: typeof resolveProfile;
    setApiKey: (rawKey: string, opts?: { path?: string }) => Promise<void>;
    clearApiKey: (opts?: { path?: string }) => Promise<void>;
  };

  readonly recipe = {
    load: loadRecipe,
    merge: mergeRecipes,
  };

  readonly sidecar = {
    read: readSidecar,
    write: writeSidecar,
  };

  readonly image = {
    hash,
    detectFormat,
    shrinkForVision,
  };

  readonly log = {
    open: openLog,
    append: appendLog,
    close: closeLog,
    createLogger,
  };

  readonly model = {
    install: (key: ModelKey, opts?: ModelInstallOptions): Promise<InstalledModel> =>
      installModelImpl(this.ctx, key, opts),
    installAll: (opts?: ModelInstallOptions): Promise<ModelInstallResult> =>
      installAllModelsImpl(this.ctx, opts),
    list: (): ModelListResult => listModelsImpl(this.ctx),
    verify: (opts?: ModelVerifyOptions): Promise<ModelVerifyResult> =>
      verifyModelsImpl(this.ctx, opts),
  };

  constructor(opts: GptImgOptions = {}) {
    this.profileDir = opts.profileDir === undefined ? defaultProfileDir() : resolveDirOption(opts.profileDir, "profileDir");
    ensureSecureProfileRoot(this.profileDir);
    this.logDir = opts.logDir === undefined ? defaultLogDir(this.profileDir) : resolveDirOption(opts.logDir, "logDir");

    this.profile = {
      load: loadProfile,
      resolve: resolveProfile,
      setApiKey: (rawKey, options) =>
        setApiKey(options?.path ?? defaultProfilePath(this.profileDir), rawKey),
      clearApiKey: (options) =>
        clearApiKey(options?.path ?? defaultProfilePath(this.profileDir)),
    };
  }

  private get ctx(): { profileDir: string; logDir: string } {
    return { profileDir: this.profileDir, logDir: this.logDir };
  }

  generate(args: GenerateArgs, opts?: VerbCallOptions): Promise<GenerateResult> {
    return generateImpl(this.ctx, args, opts);
  }

  edit(args: EditArgs, opts?: VerbCallOptions): Promise<EditResult> {
    return editImpl(this.ctx, args, opts);
  }

  vision(args: VisionArgs, opts?: VerbCallOptions): Promise<VisionResult> {
    return visionImpl(this.ctx, args, opts);
  }

  mask(args: MaskArgs, opts?: VerbCallOptions): Promise<MaskResult> {
    return maskImpl(this.ctx, args, opts);
  }

  compose(args: ComposeArgs, opts?: VerbCallOptions): Promise<ComposeResult> {
    return composeImpl(this.ctx, args, opts);
  }

  combine(args: CombineArgs, opts?: VerbCallOptions): Promise<CombineResult> {
    return combineImpl(this.ctx, args, opts);
  }

  despeckle(args: DespeckleArgs, opts?: VerbCallOptions): Promise<DespeckleResult> {
    return despeckleImpl(this.ctx, args, opts);
  }

  keycheck(args: KeycheckArgs, opts?: VerbCallOptions): Promise<KeycheckResult> {
    return keycheckImpl(this.ctx, args, opts);
  }

  framecheck(args: FramecheckArgs, opts?: VerbCallOptions): Promise<FramecheckResult> {
    return framecheckImpl(this.ctx, args, opts);
  }

  trim(args: TrimArgs, opts?: VerbCallOptions): Promise<TrimResult> {
    return trimImpl(this.ctx, args, opts);
  }

  backplate(args: BackplateArgs, opts?: VerbCallOptions): Promise<BackplateResult> {
    return backplateImpl(this.ctx, args, opts);
  }

  layer(args: LayerArgs, opts?: VerbCallOptions): Promise<LayerResult> {
    return layerImpl(this.ctx, args, opts);
  }

  shadow(args: ShadowArgs, opts?: VerbCallOptions): Promise<ShadowResult> {
    return shadowImpl(this.ctx, args, opts);
  }

  icon(args: IconArgs, opts?: VerbCallOptions): Promise<IconResult> {
    return iconImpl(this.ctx, args, opts);
  }

  upscale(args: UpscaleArgs, opts?: VerbCallOptions): Promise<UpscaleResult> {
    return upscaleImpl(this.ctx, args, opts);
  }

  resize(args: ResizeArgs, opts?: VerbCallOptions): Promise<ResizeResult> {
    return resizeImpl(this.ctx, args, opts);
  }

  encode(args: EncodeArgs, opts?: VerbCallOptions): Promise<EncodeResult> {
    return encodeImpl(this.ctx, args, opts);
  }

  grid(args: GridArgs, opts?: VerbCallOptions): Promise<GridResult> {
    return gridImpl(this.ctx, args, opts);
  }
}
