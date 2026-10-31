// The files a launch reads, checked before anything is written
// (store-recovery-conventions, What a refused file does): a newer file of any
// kind, and unreadable settings or secrets, stop the launch; unreadable window
// state falls back; an unreadable records or backups store is left off for the
// session with a notice.
import { parseUiState, type UiState } from "../shared/ui-state.ts";
import type { KeyStore } from "./api-keys.ts";
import { loadConfig, type LoadedConfig } from "./config.ts";
import { probeDatabase, readHeader, type RefusedFile } from "./file-header.ts";
import { readText, type ReadResult } from "./files.ts";
import type { AppPaths } from "./paths.ts";

export interface LaunchFiles {
  config: LoadedConfig;
  ui: UiState;
  /** Files that stop the launch, each named with why; empty when it may go on. */
  refused: RefusedFile[];
  /** Side stores that cannot be read: left untouched and off for the session. */
  storesOff: ("records" | "backups")[];
}

export async function checkLaunchFiles(paths: Pick<AppPaths, "config" | "apiKeys" | "state" | "records" | "backups">, keys: KeyStore, configRead?: ReadResult): Promise<LaunchFiles> {
  const refused: RefusedFile[] = [];
  const config = await loadConfig(paths.config, configRead);
  if (config.refused) refused.push({ path: paths.config, reason: config.refused });
  const keysRefusal = await keys.refusal();
  if (keysRefusal) refused.push({ path: paths.apiKeys, reason: keysRefusal });

  let ui = parseUiState(null);
  const stateRead = await readText(paths.state);
  if (stateRead.kind === "ok") {
    let header: ReturnType<typeof readHeader> = { kind: "unreadable" };
    try { header = readHeader(JSON.parse(stateRead.text), "state"); } catch { /* unreadable */ }
    // Window and pane state is disposable: an unreadable copy is dropped and the next save replaces it.
    if (header.kind === "ok") ui = parseUiState(header.body);
    else if (header.kind === "newer") refused.push({ path: paths.state, reason: "newer" });
  }

  const storesOff: LaunchFiles["storesOff"] = [];
  for (const kind of ["records", "backups"] as const) {
    const probe = probeDatabase(paths[kind], kind);
    if (probe === "newer") refused.push({ path: paths[kind], reason: "newer" });
    else if (probe === "unreadable") storesOff.push(kind);
  }
  return { config, ui, refused, storesOff };
}
