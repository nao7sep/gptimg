// config.json: the set map, read at launch without writing anything, written
// only by Save with the sets that differ from their built-ins. An unreadable
// file is never overwritten: Save stays held until the user fixes or moves it
// (store-recovery-conventions).
import { message, type Message } from "../shared/i18n/translator.ts";
import { builtInSettings, differingSets, readSets, type SetKey, type Settings } from "../shared/settings.ts";
import { json, readText, writeTextAtomic } from "./files.ts";

export interface LoadedConfig {
  settings: Settings;
  /** Keys this version does not know, kept on every save. */
  unknown: Record<string, unknown>;
  invalid: SetKey[];
  /** Set when the file exists but cannot be read or parsed. */
  locked: boolean;
  problem: Message | null;
}

export async function loadConfig(path: string): Promise<LoadedConfig> {
  const read = await readText(path);
  if (read.kind === "absent") return { settings: builtInSettings(), unknown: {}, invalid: [], locked: false, problem: null };
  if (read.kind === "failed") {
    return { settings: builtInSettings(), unknown: {}, invalid: [], locked: true, problem: message("settings.problem.unreadable", { path }) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { settings: builtInSettings(), unknown: {}, invalid: [], locked: true, problem: message("settings.problem.malformed", { path }) };
  }
  const { settings, invalid, unknown } = readSets(parsed as Record<string, unknown>);
  return {
    settings,
    unknown,
    invalid,
    locked: false,
    problem: invalid.length > 0 ? message("settings.problem.invalidSets", { count: invalid.length }) : null,
  };
}

/** The bytes Save writes: the differing sets whole, unknown keys preserved. */
export function configText(settings: Settings, unknown: Record<string, unknown>): string {
  return json({ ...unknown, ...differingSets(settings) });
}

export async function saveConfig(path: string, settings: Settings, unknown: Record<string, unknown>, existed: boolean): Promise<string | null> {
  const differing = differingSets(settings);
  // First run writes nothing: with no file and nothing differing, there is nothing to say.
  if (!existed && Object.keys(differing).length === 0 && Object.keys(unknown).length === 0) return null;
  const text = configText(settings, unknown);
  return (await writeTextAtomic(path, text)) ? text : null;
}
