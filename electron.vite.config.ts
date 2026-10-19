import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

const version = (JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string }).version;
export const DEV_PORT = 25793;
const define = { __APP_VERSION__: JSON.stringify(version) };

export default defineConfig({
  main: {
    define,
    build: {
      // The SDK is bundled from its TypeScript source; its native modules stay
      // external and ship in the app's own dependencies.
      externalizeDeps: { exclude: ["gptimgsdk"] },
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          "sdk-worker": resolve("src/main/sdk-worker.ts"),
        },
        external: ["sharp", "onnxruntime-node"],
      },
    },
  },
  preload: {
    build: {
      // A sandboxed preload must be CommonJS.
      rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: {
    define,
    plugins: [react()],
    // GptImg's fixed development endpoint; strict, so it never drifts to another app's port.
    server: { host: "127.0.0.1", port: DEV_PORT, strictPort: true },
  },
});
