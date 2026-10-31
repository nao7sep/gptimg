import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { KeyStore } from "../../src/main/api-keys.ts";
import { withHeader } from "../../src/main/file-header.ts";
import { checkLaunchFiles } from "../../src/main/launch-files.ts";

function folder() {
  const root = mkdtempSync(join(tmpdir(), "gptimg-launch-"));
  const paths = {
    config: join(root, "config.json"),
    apiKeys: join(root, "api-keys.json"),
    state: join(root, "state.json"),
    records: join(root, "records.sqlite3"),
    backups: join(root, "backups.sqlite3"),
  };
  const check = () => checkLaunchFiles(paths, new KeyStore(paths.apiKeys, {}, () => {}));
  return { root, paths, check };
}

const newer = (kind: string) => JSON.stringify({ format: { owner: "gptimg", kind, version: 2 }, writer: { name: "gptimg", version: "9.0.0" } });

function snapshot(root: string): Record<string, string> {
  return Object.fromEntries(readdirSync(root).sort().map((name) => [name, readFileSync(join(root, name)).toString("base64")]));
}

describe("the files a launch reads", () => {
  it("lets a first launch go on, with nothing on disk and nothing written", async () => {
    const { root, check } = folder();
    expect(await check()).toMatchObject({ refused: [], storesOff: [] });
    expect(readdirSync(root)).toEqual([]);
  });

  it.each([
    ["config", "config.json", "config"],
    ["apiKeys", "api-keys.json", "api-keys"],
    ["state", "state.json", "state"],
  ] as const)("stops for a newer %s, naming it, and writes nothing", async (key, _name, kind) => {
    const { root, paths, check } = folder();
    writeFileSync(paths[key], newer(kind));
    const before = snapshot(root);
    expect((await check()).refused).toEqual([{ path: paths[key], reason: "newer" }]);
    expect(snapshot(root)).toEqual(before);
  });

  it.each(["config", "apiKeys"] as const)("stops for an unreadable %s, naming it, and writes nothing", async (key) => {
    const { root, paths, check } = folder();
    for (const text of ["{ broken", JSON.stringify({ theme: "dark" }), JSON.stringify(withHeader(key === "config" ? "state" : "config", {}))]) {
      writeFileSync(paths[key], text);
      const before = snapshot(root);
      expect((await check()).refused).toEqual([{ path: paths[key], reason: "unreadable" }]);
      expect(snapshot(root)).toEqual(before);
    }
  });

  it("drops an unreadable state.json for defaults, with no notice, and does not stop", async () => {
    const { paths, check } = folder();
    writeFileSync(paths.state, "{ broken");
    const launch = await check();
    expect(launch.refused).toEqual([]);
    expect(launch.ui.railWidth).toBeNull();
  });

  it("names every refused file at once", async () => {
    const { paths, check } = folder();
    writeFileSync(paths.config, "{ broken");
    writeFileSync(paths.state, newer("state"));
    expect((await check()).refused).toEqual([{ path: paths.config, reason: "unreadable" }, { path: paths.state, reason: "newer" }]);
  });

  it.each(["records", "backups"] as const)("stops for a newer %s store and leaves an unreadable one off, both untouched", async (kind) => {
    const { root, paths, check } = folder();
    const db = new DatabaseSync(paths[kind]);
    db.exec("CREATE TABLE file_header (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec(`INSERT INTO file_header VALUES ('format.owner', 'gptimg'), ('format.kind', '${kind}')`);
    db.exec("PRAGMA user_version = 2");
    db.close();
    let before = snapshot(root);
    expect((await check()).refused).toEqual([{ path: paths[kind], reason: "newer" }]);
    expect(snapshot(root)).toEqual(before);

    writeFileSync(paths[kind], "not a database");
    before = snapshot(root);
    expect(await check()).toMatchObject({ refused: [], storesOff: [kind] });
    expect(snapshot(root)).toEqual(before);
  });
});
