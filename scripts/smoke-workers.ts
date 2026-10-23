// Offline, no-window smoke of the built SDK worker and production host.
// Run after npm run build: node scripts/smoke-workers.ts [sdk-worker.js]
// Uses only temporary input/output and never invokes a provider or downloads a model.
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import sharp from "sharp";
import { build } from "vite";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temp = await mkdtemp(join(tmpdir(), "gptimg-worker-smoke-"));
try {
  const entry = resolve(process.argv[2] ?? join(root, "out/main/sdk-worker.js"));
  await build({
    configFile: false, logLevel: "error",
    build: { outDir: temp, emptyOutDir: false,
      lib: { entry: { host: join(root, "src/main/sdk-host.ts"), storehost: join(root, "src/main/store-host.ts") }, formats: ["es"], fileName: (_format, name) => `${name}.mjs` },
      rollupOptions: { external: [/^node:/, "electron"] },
    },
  });
  await sharp({ create: { width: 48, height: 24, channels: 4, background: "#b56944" } }).png().toFile(join(temp, "input.png"));
  await writeFile(join(temp, "smoke.mjs"), `
import { app } from "electron";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { SdkHost } from "./host.mjs";
import { StoreHost } from "./storehost.mjs";
const temp = ${JSON.stringify(temp)};
mkdirSync(temp + "/electron/session", { recursive: true });
app.setPath("userData", temp + "/electron");
app.setPath("sessionData", temp + "/electron/session");
const deadline = setTimeout(() => { console.error("Worker smoke timed out"); app.exit(1); }, 60000);
void (async () => {
console.log("Waiting for Electron readiness");
await app.whenReady();
console.log("Electron ready; starting SDK utility process");
app.dock?.hide();
const host = new SdkHost(${JSON.stringify(entry)}, (code) => console.log("SDK exited", code));
try {
  const identity = { name: "GptImg smoke", version: "test" };
  let result = await host.call("inspect", identity, { in: temp + "/input.png" }).done;
  assert.equal(result.kind, "result", JSON.stringify(result));
  assert.equal(result.result.width, 48);
  result = await host.call("encode", identity, { in: temp + "/input.png", out: temp + "/output.png", format: "png" }).done;
  assert.equal(result.kind, "result", JSON.stringify(result));
  assert.equal(result.result.status, "completed");
  await host.restart();
  result = await host.call("inspect", identity, { in: temp + "/output.png" }).done;
  assert.equal(result.kind, "result", JSON.stringify(result));
  assert.equal(result.result.height, 24);
  await host.restart();
  const paths = { root: temp, config: temp + "/config.json", state: temp + "/state.json", records: temp + "/records.sqlite3", backups: temp + "/backups.sqlite3", apiKeys: temp + "/api-keys.json", staging: temp + "/staging", logs: temp + "/logs" };
  const stores = new StoreHost(${JSON.stringify(join(dirname(entry), "store-worker.js"))}, paths, "smoke", "test");
  stores.records.log("info", "app.start", { smoke: true });
  const page = await stores.records.query({});
  assert.equal(page.failed, false);
  assert.equal(page.rows.length, 1);
  await stores.close();
  console.log("Built workers: inspect, encode, restart and record roundtrip passed");
  clearTimeout(deadline);
  app.exit(0);
} catch (error) { console.error(error); host.stop(); app.exit(1); }
})();
`);
  const env: NodeJS.ProcessEnv = { ...process.env, GPTIMG_DATA_DIR: temp };
  delete env.ELECTRON_RUN_AS_NODE;
  const status = await new Promise<number>((done, reject) => {
    const child = spawn(electron as unknown as string, [join(temp, "smoke.mjs")], { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => done(code ?? 1));
  });
  if (status !== 0) throw new Error(`Worker smoke failed (${status})`);
} finally { await rm(temp, { recursive: true, force: true }); }
