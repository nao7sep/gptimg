// Every path the app keeps under its storage root, in one place
// (storage-path-conventions): ~/.gptimg, or GPTIMG_DATA_DIR when set.
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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
  /** Where a log line goes when records.sqlite3 cannot take it. */
  logs: string;
}

export function dataRoot(env: NodeJS.ProcessEnv = process.env): { dir: string; fromEnv: boolean } {
  const home = homedir();
  const override = env[DATA_DIR_ENV]?.trim();
  if (!override) return { dir: join(home, ".gptimg"), fromEnv: false };
  try {
    // Expand only this authored override, once. Picker and stored collection paths stay literal.
    let expanded = override.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)|%([A-Za-z_][A-Za-z0-9_]*)%/g, (_reference, braced: string | undefined, dollar: string | undefined, percent: string | undefined) => {
      const name = (braced ?? dollar ?? percent)!;
      const value = env[name];
      if (!value) throw new Error(`Storage folder environment variable is empty or unset: ${name}`);
      return value;
    });
    if (expanded === "~" || /^~[/\\]/.test(expanded)) expanded = home + expanded.slice(1);
    return { dir: resolve(home, expanded), fromEnv: true };
  } catch (error) {
    throw new DataDirError(override, true, error);
  }
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
    logs: join(root, "logs"),
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
