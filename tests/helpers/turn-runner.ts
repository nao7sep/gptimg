// A TurnRunner over a real chats folder, with a scripted SDK chat and a clock
// that advances a second per reading, for tests of turns and of session order.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GptImgError, type ErrorCode, type ErrorEffect, type VerbCallOptions } from "gptimgsdk";
import type { Records } from "../../src/main/records.ts";
import { SessionCatalog } from "../../src/main/session-catalog.ts";
import { TurnRunner, type TurnDeps } from "../../src/main/turns.ts";
import { summarize, type SessionChange } from "../../src/shared/session.ts";
import { builtInSettings } from "../../src/shared/settings.ts";

export interface Call {
  args: Record<string, unknown>;
  cancelled: boolean;
}

/** What the scripted chat does: return a result, or throw the SDK's error with this code and effect. */
export type Answer = { kind: "result"; result: Record<string, unknown> } | { kind: "error"; code: ErrorCode; effect?: ErrorEffect };

/** A call that failed after it may have reached OpenAI. */
export const dropped: Answer = { kind: "error", code: "provider.connectionLost", effect: "unknown" };
export const cancelled: Answer = { kind: "error", code: "cancelled", effect: "unknown" };

export function setup(answer: (call: Call) => Answer | Promise<Answer>, key: string | null = "sk-test") {
  const root = mkdtempSync(join(tmpdir(), "gptimg-turns-"));
  const calls: Call[] = [];
  const sdk: TurnDeps["sdk"] = () => ({
    async chat(args: unknown, options: VerbCallOptions = {}) {
      const call: Call = { args: args as Record<string, unknown>, cancelled: false };
      calls.push(call);
      options.signal?.addEventListener("abort", () => (call.cancelled = true));
      options.onEvent?.({ event: "verb.start", level: "info" } as never);
      await Promise.resolve();
      const settled = await answer(call);
      if (settled.kind === "error") throw new GptImgError(settled.code, "x", { effect: settled.effect ?? "none" });
      return settled.result as never;
    },
  });
  const turnsRecorded: unknown[] = [];
  const records = { sessionId: "l", log() {}, sdkEvent() {}, turn: (r: unknown) => turnsRecorded.push(r), close() {} } as unknown as Records;
  const started: string[] = [];
  const released: string[] = [];
  // Main's listing, kept by the runner's saves as in the app.
  const changes: SessionChange[] = [];
  const catalog = new SessionCatalog((change) => changes.push(change));
  let tick = 0;
  const runner = new TurnRunner({
    sdk,
    records,
    settings: () => ({ ...builtInSettings(), sessionsDir: root }),
    apiKey: async () => key,
    backup: () => {},
    releaseStaged: (p) => released.push(p),
    saved: (dir, id, doc) => catalog.change(dir, id, summarize(id, doc)),
    started: (requestId) => started.push(requestId),
    now: () => new Date(Date.UTC(2026, 9, 19, 3, 0, tick++)),
  });
  return { root, runner, calls, turnsRecorded, started, released, catalog, changes };
}

export const completed = (outDir: string, responseId: string, file = "img.png"): Answer => ({
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
