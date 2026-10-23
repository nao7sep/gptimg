import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Execute the real launcher helper with disposable fake binaries and a process
// inventory double; these tests never inspect or signal the developer's apps.
const helper = path.resolve(import.meta.dirname, "../../scripts/launcher.sh");
const harness = `
source "$1"
trap - EXIT
ROOT="$2"
APP="$ROOT/built/GptImg.app"
DEV_ELECTRON="$ROOT/dev/Electron.app"
ps() {
  if [[ "$1" == "-axo" ]]; then
    [[ "$LAUNCHER_CASE" == "none" ]] && return 0
    print -r -- "101 99 $APP/Contents/MacOS/GptImg"
    print -r -- "102 98 $DEV_ELECTRON/Contents/MacOS/Electron"
    print -r -- "103 97 $APP/Contents/MacOS/GptImg-other"
    return 0
  fi
  if [[ "$3" == "-o" && "$4" == "command=" ]]; then
    print -r -- "node $ROOT/node_modules/.bin/electron-vite dev"
    return 0
  fi
  print -r -- "$2" >> "$ROOT/checked-pids"
  if [[ "$2" == "101" || "$2" == "102" || "$2" == "98" ]]; then
    [[ "$LAUNCHER_CASE" == "decline" || ! -f "$ROOT/requests-complete" ]] && return 0
  fi
  return 1
}
sleep() {
  if [[ "$LAUNCHER_CASE" == "decline" ]]; then
    SECONDS=$(( SECONDS + 30 ))
  else
    command sleep 0.01
  fi
}
stop_running
result=$?
wait
exit $result
`;

describe.skipIf(process.platform !== "darwin")("macOS graceful launcher replacement", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "gptimg launcher "));
    for (const [folder, name] of [["built/GptImg.app", "GptImg"], ["dev/Electron.app", "Electron"]]) {
      const dir = path.join(root, folder!, "Contents/MacOS");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, name!), `#!/bin/zsh\nprint -r -- "$0|$*" >> "$LAUNCHER_TEST_ROOT/requests"\ntouch "$LAUNCHER_TEST_ROOT/requests-complete"\n`, { mode: 0o755 });
    }
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const run = (root: string, mode: string) => spawnSync("zsh", ["-c", harness, "launcher-test", helper, root], {
    encoding: "utf8", timeout: 5000,
    env: { ...process.env, LAUNCHER_CASE: mode, LAUNCHER_TEST_ROOT: root },
  });

  it("requests normal quit from each exact executable and waits for the dev supervisor", async () => {
    const result = run(root, "success");
    expect(result.status, result.stderr).toBe(0);
    const requests = (await readFile(path.join(root, "requests"), "utf8")).trim().split("\n").sort();
    expect(requests).toEqual([
      `${root}/built/GptImg.app/Contents/MacOS/GptImg|--gptimg-quit-for-replacement`,
      `${root}/dev/Electron.app/Contents/MacOS/Electron|${root} --gptimg-quit-for-replacement`,
    ]);
    const checked = (await readFile(path.join(root, "checked-pids"), "utf8")).trim().split("\n");
    expect(checked).toEqual(expect.arrayContaining(["101", "102", "98"]));
    expect(checked).not.toContain("103");
  });

  it("fails after the bounded wait when quit is declined", async () => {
    const result = run(root, "decline");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No replacement was launched");
    expect(result.stderr).toContain("Finish or cancel its current work");
    expect((await readFile(path.join(root, "requests"), "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("makes no quit request when this checkout has no running app", async () => {
    const result = run(root, "none");
    expect(result.status, result.stderr).toBe(0);
    await expect(readFile(path.join(root, "requests"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
