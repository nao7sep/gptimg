import { hash } from "./image/hash.js";
import { detectFormat } from "./image/detectFormat.js";
import { shrinkForVision } from "./image/shrinkForVision.js";
import {
  appendLog,
  closeLog,
  createLogger,
  openLog,
} from "./log/index.js";
import { loadProfile } from "./profile/load.js";
import { resolveProfile } from "./profile/resolve.js";
import { clearApiKey, setApiKey } from "./profile/setApiKey.js";
import { applySet } from "./recipe/applySet.js";
import { loadRecipe } from "./recipe/load.js";
import { mergeRecipes } from "./recipe/merge.js";
import { readSidecar } from "./sidecar/read.js";
import { writeSidecar } from "./sidecar/write.js";
import {
  DEFAULT_PROFILE_DIR,
  defaultLogDir,
  defaultProfilePath,
} from "./internal/paths.js";
import type {
  BackplateArgs,
  BackplateResult,
  CombineArgs,
  CombineResult,
  ComposeArgs,
  ComposeResult,
  EditArgs,
  EditResult,
  GenerateArgs,
  GenerateResult,
  GptImgOptions,
  LayerArgs,
  LayerResult,
  MaskArgs,
  MaskResult,
  ResizeArgs,
  ResizeResult,
  TrimArgs,
  TrimResult,
  UpscaleArgs,
  UpscaleResult,
  VisionArgs,
  VisionResult,
} from "./types.js";
import { backplateImpl } from "./verbs/backplate.js";
import { combineImpl } from "./verbs/combine.js";
import { composeImpl } from "./verbs/compose.js";
import { editImpl } from "./verbs/edit.js";
import { generateImpl } from "./verbs/generate.js";
import { layerImpl } from "./verbs/layer.js";
import { maskImpl } from "./verbs/mask.js";
import { installModelImpl, listModelsImpl } from "./verbs/model.js";
import type { ModelInstallOptions } from "./verbs/model.js";
import type { VerbCallOptions } from "./verbs/options.js";
import { resizeImpl } from "./verbs/resize.js";
import { trimImpl } from "./verbs/trim.js";
import { upscaleImpl } from "./verbs/upscale.js";
import { visionImpl } from "./verbs/vision.js";
import type { ModelKey } from "./local/models/registry.js";
import type { ModelInstallResult, ModelListEntry } from "./types.js";

export type { VerbCallOptions } from "./verbs/options.js";
export type { ModelInstallOptions } from "./verbs/model.js";

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
    applySet,
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
    install: (key: ModelKey, opts?: ModelInstallOptions): Promise<ModelInstallResult> =>
      installModelImpl(this.ctx, key, opts),
    list: (): ModelListEntry[] => listModelsImpl(this.ctx),
  };

  constructor(opts: GptImgOptions = {}) {
    this.profileDir = opts.profileDir ?? DEFAULT_PROFILE_DIR;
    this.logDir = opts.logDir ?? defaultLogDir(this.profileDir);

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

  trim(args: TrimArgs, opts?: VerbCallOptions): Promise<TrimResult> {
    return trimImpl(this.ctx, args, opts);
  }

  backplate(args: BackplateArgs, opts?: VerbCallOptions): Promise<BackplateResult> {
    return backplateImpl(this.ctx, args, opts);
  }

  layer(args: LayerArgs, opts?: VerbCallOptions): Promise<LayerResult> {
    return layerImpl(this.ctx, args, opts);
  }

  upscale(args: UpscaleArgs, opts?: VerbCallOptions): Promise<UpscaleResult> {
    return upscaleImpl(this.ctx, args, opts);
  }

  resize(args: ResizeArgs, opts?: VerbCallOptions): Promise<ResizeResult> {
    return resizeImpl(this.ctx, args, opts);
  }
}
