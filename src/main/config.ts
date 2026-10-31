// config.json: the set map, read at launch without writing anything, written
// only by Save with the sets that differ from their built-ins. A file this
// build cannot read, or one a newer version wrote, stops the launch; Save
// checks the file again at the write and never replaces a refused one
// (store-recovery-conventions).
import { message, type Message } from "../shared/i18n/translator.ts";
import { builtInSettings, differingSets, readSets, type SetKey, type Settings } from "../shared/settings.ts";
import { readHeader, withHeader, type Refusal } from "./file-header.ts";
import { json, readText, writeTextAtomic, type ReadResult } from "./files.ts";

export interface LoadedConfig {
  settings: Settings;
  /** Keys this version does not know, kept on every save. */
  unknown: Record<string, unknown>;
  invalid: SetKey[];
  /** The stored values of the invalid sets, kept on save until the user changes that set. */
  kept: Partial<Record<SetKey, unknown>>;
  /** Set when the file is refused: the launch stops and nothing is saved over it. */
  refused: Refusal | null;
  problem: Message | null;
}

function refusedConfig(refused: Refusal): LoadedConfig {
  return { settings: builtInSettings(), unknown: {}, invalid: [], kept: {}, refused, problem: null };
}

/** The header check alone: whether the text is a config.json this build reads. */
function parse(text: string): ReturnType<typeof readHeader> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "unreadable" };
  }
  return readHeader(parsed, "config");
}

export async function loadConfig(path: string, snapshot?: ReadResult): Promise<LoadedConfig> {
  const read = snapshot ?? await readText(path);
  if (read.kind === "absent") return { settings: builtInSettings(), unknown: {}, invalid: [], kept: {}, refused: null, problem: null };
  if (read.kind === "failed") return refusedConfig("unreadable");
  const header = parse(read.text);
  if (header.kind === "newer") return refusedConfig("newer");
  if (header.kind !== "ok") return refusedConfig("unreadable");
  const { settings, invalid, unknown } = readSets(header.body);
  const kept: Partial<Record<SetKey, unknown>> = {};
  for (const key of invalid) kept[key] = header.body[key];
  return { settings, unknown, invalid, kept, refused: null, problem: invalidProblem(invalid.length) };
}

export function invalidProblem(count: number): Message | null {
  return count > 0 ? message("settings.problem.invalidSets", { count }) : null;
}

/** The invalid sets still kept once `settings` is saved: those the user left at the default shown. */
export function stillKept(settings: Settings, kept: Partial<Record<SetKey, unknown>>): Partial<Record<SetKey, unknown>> {
  const builtIn = builtInSettings();
  const out: Partial<Record<SetKey, unknown>> = {};
  for (const key of Object.keys(kept) as SetKey[]) {
    if (JSON.stringify(settings[key]) === JSON.stringify(builtIn[key])) out[key] = kept[key];
  }
  return out;
}

/** The bytes Save writes: the differing sets whole, unknown keys and untouched invalid values preserved. */
export function configText(settings: Settings, unknown: Record<string, unknown>, kept: Partial<Record<SetKey, unknown>> = {}): string {
  return json(withHeader("config", { ...unknown, ...differingSets(settings), ...stillKept(settings, kept) }));
}

/** Thrown when the file on disk is refused at the moment of saving; it is left as it is. */
export class ConfigRefused extends Error {
  readonly reason: Refusal;

  constructor(reason: Refusal) {
    super(`config.json is ${reason}; it was left unchanged`);
    this.reason = reason;
  }
}

export async function saveConfig(path: string, settings: Settings, unknown: Record<string, unknown>, existed: boolean, kept: Partial<Record<SetKey, unknown>> = {}): Promise<string | null> {
  // The file is checked again at the write: one replaced since launch is never saved over.
  const current = await readText(path);
  if (current.kind === "failed") throw new ConfigRefused("unreadable");
  if (current.kind === "ok") {
    const header = parse(current.text);
    if (header.kind !== "ok") throw new ConfigRefused(header.kind);
  }
  const differing = differingSets(settings);
  // First run writes nothing: with no file and nothing differing, there is nothing to say.
  if (!existed && current.kind === "absent" && Object.keys(differing).length === 0 && Object.keys(unknown).length === 0) return null;
  const text = configText(settings, unknown, kept);
  return (await writeTextAtomic(path, text)) ? text : null;
}
