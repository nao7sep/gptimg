// A TurnRunner over a real chats folder, with a scripted SDK host and a clock
// that advances a second per reading, for tests of turns and of session order.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Records } from "../../src/main/records.ts";
import type { CallSettlement, SdkHost } from "../../src/main/sdk-host.ts";
import { TurnRunner } from "../../src/main/turns.ts";
import { builtInSettings } from "../../src/shared/settings.ts";

export interface Call {
  args: Record<string, unknown>;
  cancelled: boolean;
}

export function setup(answer: (call: Call) => CallSettlement | Promise<CallSettlement>, key: string | null = "sk-test") {
  const root = mkdtempSync(join(tmpdir(), "gptimg-turns-"));
  const calls: Call[] = [];
  const host = {
    chat(_key: string, _baseURL: string | null, _app: unknown, args: Record<string, unknown>, { onEvent }: { onEvent: (e: Record<string, unknown>) => void }) {
      const call: Call = { args, cancelled: false };
      calls.push(call);
      onEvent({ event: "verb.start", level: "info" });
      return { id: "c", done: Promise.resolve().then(() => answer(call)), cancel: () => (call.cancelled = true) };
    },
  } as unknown as SdkHost;
  const turnsRecorded: unknown[] = [];
  const records = { sessionId: "l", log() {}, sdkEvent() {}, turn: (r: unknown) => turnsRecorded.push(r), close() {} } as unknown as Records;
  const started: string[] = [];
  const released: string[] = [];
  let tick = 0;
  const runner = new TurnRunner({
    host,
    records,
    settings: () => ({ ...builtInSettings(), sessionsDir: root }),
    apiKey: async () => key,
    app: { name: "GptImg", version: "0" },
    backup: () => {},
    releaseStaged: (p) => released.push(p),
    started: (requestId) => started.push(requestId),
    now: () => new Date(Date.UTC(2026, 9, 19, 3, 0, tick++)),
  });
  return { root, runner, calls, turnsRecorded, started, released };
}

export const completed = (outDir: string, responseId: string, file = "img.png"): CallSettlement => ({
  kind: "result",
  result: {
    status: "completed",
    text: "Here it is.",
    files: [{ path: join(outDir, file) }],
    failures: [],
    responseId,
    resumed: null,
    incomplete: null,
    response: { id: responseId, usage: { input_tokens: 12, output_tokens: 34 } },
    usage: { input: 12, output: 34 },
  },
});

export const request = (sessionId: string | null, text: string, references: string[] = []) => ({
  requestId: `r-${text}`,
  sessionId,
  text,
  references,
  options: { size: "1024x1024", quality: "low" },
});
