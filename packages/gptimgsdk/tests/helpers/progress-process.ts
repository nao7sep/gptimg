// Run only as a child process so Node's default unhandled-rejection behavior
// remains enabled, without adding process-global handlers to the test runner.
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { GptImg } from "../../src/index.ts";
import type { LogEntry } from "../../src/types.ts";

const [scenario, directory] = process.argv.slice(2);
assert(directory);
assert(["async-progress", "thenable-progress", "async-notice", "pending-progress"].includes(scenario ?? ""));
const sdk = new GptImg({ profileDir: directory, logDir: directory });
const events: LogEntry[] = [];
let thenablesObserved = 0;
let release!: () => void;
let callbackSettled = false;
const callbackGate = new Promise<void>((resolve) => { release = resolve; });
void callbackGate.then(() => { callbackSettled = true; });

const onProgress = (event: LogEntry) => {
  events.push(event);
  if (scenario === "pending-progress") return callbackGate;
  if (scenario === "thenable-progress") {
    return {
      then(_resolve: unknown, reject: (reason: unknown) => void) {
        thenablesObserved++;
        reject(new Error("thenable progress sink failed"));
      },
    };
  }
  if (scenario === "async-progress" || event.message === "log file unavailable") {
    return (async () => { throw new Error("async progress sink failed"); })();
  }
};

let pendingAtFinish = false;
try {
  const failedLog = path.join(directory, "directory-as-log");
  if (scenario === "async-notice") await mkdir(failedLog);
  const results = await Promise.all([
    sdk.backplate({
      size: 16, from: "#ffffff", to: "#000000", outDir: directory, outName: "watched",
      ...(scenario === "async-notice" && { log: failedLog }),
    }, { onProgress }),
    sdk.backplate({ size: 16, from: "#ff0000", to: "#000000", outDir: directory, outName: "peer" }),
  ]);
  for (const result of results) {
    assert.equal(result.size, 16);
    const image = await readFile(result.output);
    assert.equal(image.subarray(1, 4).toString(), "PNG");
    if (result.logPath !== failedLog) {
      const lines = (await readFile(result.logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(lines.length, 2);
      assert.equal(lines[1].message, "wrote backplate");
    }
  }
  assert.equal(events.filter((event) => event.stage !== "log").length, 2);
  const notices = events.filter((event) => event.message === "log file unavailable");
  assert.equal(notices.length, scenario === "async-notice" ? 1 : 0);
  if (scenario === "thenable-progress") assert.equal(thenablesObserved, 2);
  pendingAtFinish = !callbackSettled;
  if (scenario === "pending-progress") assert(pendingAtFinish);
  // Give Node its rejection checkpoint without setting a timing bound.
  await setImmediate();
  process.stdout.write(JSON.stringify({ outputs: results.length, events: events.length, notices: notices.length, pendingAtFinish }));
} finally {
  release();
  await callbackGate;
}
