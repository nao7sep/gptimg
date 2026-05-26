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
import { applyPatch } from "./recipe/applyPatch.js";
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
  InspectArgs,
  InspectResult,
  VisionArgs,
  VisionResult,
} from "./types.js";
import { chromaImpl } from "./verbs/chroma.js";
import { editImpl } from "./verbs/edit.js";
import { generateImpl } from "./verbs/generate.js";
import { inspectImpl } from "./verbs/inspect.js";
import { visionImpl } from "./verbs/vision.js";

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
    applyPatch,
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

  generate(args: GenerateArgs): Promise<GenerateResult> {
    return generateImpl(this.ctx, args);
  }

  edit(args: EditArgs): Promise<EditResult> {
    return editImpl(this.ctx, args);
  }

  vision(args: VisionArgs): Promise<VisionResult> {
    return visionImpl(this.ctx, args);
  }

  chroma(args: ChromaArgs): Promise<ChromaResult> {
    return chromaImpl(this.ctx, args);
  }

  inspect(args: InspectArgs): Promise<InspectResult> {
    return inspectImpl(this.ctx, args);
  }
}
