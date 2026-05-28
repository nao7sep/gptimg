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
  ChromaArgs,
  ChromaResult,
  EditArgs,
  EditResult,
  GenerateArgs,
  GenerateResult,
  GptImgOptions,
  VisionArgs,
  VisionResult,
} from "./types.js";
import { chromaImpl } from "./verbs/chroma.js";
import { editImpl } from "./verbs/edit.js";
import { generateImpl } from "./verbs/generate.js";
import type { VerbCallOptions } from "./verbs/options.js";
import { visionImpl } from "./verbs/vision.js";

export type { VerbCallOptions } from "./verbs/options.js";

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

  chroma(args: ChromaArgs, opts?: VerbCallOptions): Promise<ChromaResult> {
    return chromaImpl(this.ctx, args, opts);
  }
}
