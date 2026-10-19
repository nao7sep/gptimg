// Every path the app keeps under its storage root, in one place
// (storage-path-conventions): ~/.gptimg, or GPTIMG_DATA_DIR when set.
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const DATA_DIR_ENV = "GPTIMG_DATA_DIR";

export class DataDirError extends Error {
  readonly dir: string;
  readonly fromEnv: boolean;

  constructor(dir: string, fromEnv: boolean, cause: unknown) {
    super(`Storage folder unusable: ${dir}`, { cause });
    this.dir = dir;
    this.fromEnv = fromEnv;
  }
}

export interface AppPaths {
  root: string;
  config: string;
  state: string;
  records: string;
  backups: string;
  apiKeys: string;
  /** Pasted images waiting for a message; emptied at launch. */
  staging: string;
}

export function dataRoot(env: NodeJS.ProcessEnv = process.env): { dir: string; fromEnv: boolean } {
  const override = env[DATA_DIR_ENV]?.trim();
  if (override) return { dir: isAbsolute(override) ? override : resolve(override), fromEnv: true };
  return { dir: join(homedir(), ".gptimg"), fromEnv: false };
}

export function pathsUnder(root: string): AppPaths {
  return {
    root,
    config: join(root, "config.json"),
    state: join(root, "state.json"),
    records: join(root, "records.sqlite3"),
    backups: join(root, "backups.sqlite3"),
    apiKeys: join(root, "api-keys.json"),
    staging: join(root, "staging"),
  };
}

/** Creates the root (0700) if needed and proves it is a usable folder; an unusable override is an error, never a silent fallback. */
export function ensureDataRoot(env: NodeJS.ProcessEnv = process.env): AppPaths {
  const { dir, fromEnv } = dataRoot(env);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!statSync(dir).isDirectory()) throw new Error("not a directory");
    if (process.platform !== "win32") chmodSync(dir, 0o700);
  } catch (error) {
    throw new DataDirError(dir, fromEnv, error);
  }
  return pathsUnder(dir);
}

/** The sessions folder offered at first run: a user-document location, outside the storage root. */
export function suggestedSessionsDir(documents: string): string {
  return join(documents, "GptImg");
}
