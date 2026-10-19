// Run only as a child process so Node's default unhandled-rejection behavior
// remains enabled, without adding process-global handlers to the test runner.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { GptImg } from "../../src/index.ts";
import type { SdkEvent } from "../../src/types.ts";

const [scenario, directory] = process.argv.slice(2);
assert(directory);
assert(["async-progress", "thenable-progress", "pending-progress"].includes(scenario ?? ""));
const sdk = new GptImg();
const events: SdkEvent[] = [];
let thenablesObserved = 0;
let release!: () => void;
let callbackSettled = false;
const callbackGate = new Promise<void>((resolve) => { release = resolve; });
void callbackGate.then(() => { callbackSettled = true; });

const onEvent = (event: SdkEvent) => {
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
  return (async () => { throw new Error("async progress sink failed"); })();
};

let pendingAtFinish = false;
try {
  const results = await Promise.all([
    sdk.backplate({ size: 16, from: "#ffffff", to: "#000000", outDir: directory, outName: "watched" }, { onEvent }),
    sdk.backplate({ size: 16, from: "#ff0000", to: "#000000", outDir: directory, outName: "peer" }),
  ]);
  for (const result of results) {
    assert.equal(result.status, "completed");
    if (result.status !== "completed") throw new Error("refused");
    assert.equal(result.size, 16);
    const image = await readFile(result.output);
    assert.equal(image.subarray(1, 4).toString(), "PNG");
  }
  // The instance's startup event, then the verb's start and finish.
  assert.deepEqual(events.map((event) => event.event), ["sdk.start", "verb.start", "verb.done"]);
  if (scenario === "thenable-progress") assert.equal(thenablesObserved, 3);
  pendingAtFinish = !callbackSettled;
  if (scenario === "pending-progress") assert(pendingAtFinish);
  // Give Node its rejection checkpoint without setting a timing bound.
  await setImmediate();
  process.stdout.write(JSON.stringify({ outputs: results.length, events: events.length, pendingAtFinish }));
} finally {
  release();
  await callbackGate;
}
