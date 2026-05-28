import { homedir } from "node:os";
import path from "node:path";

export const DEFAULT_PROFILE_DIR = path.join(homedir(), ".gptimg");

export function defaultProfilePath(profileDir: string): string {
  return path.join(profileDir, "profile.json");
}

export function defaultRecipePath(profileDir: string): string {
  return path.join(profileDir, "recipe.json");
}

export function defaultLogDir(profileDir: string): string {
  return path.join(profileDir, "logs");
}

export function defaultOutDir(profileDir: string): string {
  return path.join(profileDir, "output");
}

/**
 * Where lazily fetched model files live. Default `<profileDir>/models`.
 * Override with `GPTIMG_MODELS_DIR`.
 */
export function defaultModelsDir(profileDir: string): string {
  const env = process.env.GPTIMG_MODELS_DIR;
  if (env && env.length > 0) return env;
  return path.join(profileDir, "models");
}

export function defaultLogPath(logDir: string, ts: string): string {
  return path.join(logDir, `${ts}-gptimg.jsonl`);
}

/** Returns `yyyymmdd-hhmmss-utc` per playbook. OS clock via Date. */
export function utcTimestamp(now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${now.getUTCFullYear()}` +
    `${p(now.getUTCMonth() + 1)}` +
    `${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}` +
    `${p(now.getUTCMinutes())}` +
    `${p(now.getUTCSeconds())}` +
    `-utc`
  );
}

export function defaultStem(ts: string): string {
  return `${ts}-gptimg`;
}
