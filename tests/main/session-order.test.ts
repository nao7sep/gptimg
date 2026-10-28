// Sessions are ordered as ChatGPT orders them (developer decision): a session
// moves to the top when the user sends a message, and the reply, an image or a
// failure, keeps it there. Renaming, editing a draft or attaching an image does
// not move it, nor does a reply arriving after the user has sent elsewhere: the
// order is the time of the session's latest sent message.
import { utimesSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CallSettlement } from "../../src/main/sdk-host.ts";
import { listSessions, renameSession } from "../../src/main/sessions.ts";
import { completed, request, setup } from "../helpers/turn-runner.ts";

const refused: CallSettlement = {
  kind: "result",
  result: { status: "refused", refusal: { code: "provider.moderationBlocked", message: "x", safeReason: null }, usage: null, responseId: null },
};

async function order(root: string): Promise<string[]> {
  return (await listSessions(root)).sessions.map((session) => session.title);
}

describe("session order", () => {
  it("moves a session to the top when a message is sent, and keeps it there through an image reply or a failure", async () => {
    let answer: (outDir: string) => CallSettlement = (outDir) => completed(outDir, "resp");
    const t = setup((call) => answer(call.args.outDir as string));
    const older = await t.runner.send(request(null, "older"));
    await t.runner.send(request(null, "newer"));
    expect(await order(t.root)).toEqual(["newer", "older"]);
    if (!older.ok) throw new Error("the first send failed");

    // Sending into the older session lifts it; its image reply keeps it on top.
    await t.runner.send(request(older.session.id, "again"));
    expect(await order(t.root)).toEqual(["older", "newer"]);

    // A failed reply leaves the sent message, which keeps its session on top.
    answer = () => refused;
    const newer = (await listSessions(t.root)).sessions.find((session) => session.title === "newer")!;
    const outcome = await t.runner.send(request(newer.id, "fails"));
    expect(outcome.ok).toBe(false);
    expect(await order(t.root)).toEqual(["newer", "older"]);
  });

  it("does not move a session when its reply arrives after the user has sent in another", async () => {
    let releaseSlow!: () => void;
    let calling!: () => void;
    const called = new Promise<void>((resolve) => (calling = resolve));
    const t = setup((call) =>
      call.args.message === "slow"
        ? new Promise<CallSettlement>((resolve) => {
          releaseSlow = () => resolve(completed(call.args.outDir as string, "resp-slow"));
          calling();
        })
        : completed(call.args.outDir as string, "resp"),
    );
    const slow = t.runner.send(request(null, "slow"));
    await called;
    await t.runner.send(request(null, "quick"));
    releaseSlow();
    await slow;
    expect(await order(t.root)).toEqual(["quick", "slow"]);
  });

  it("does not move a session for a rename, or for any change to its files that adds no turn", async () => {
    const t = setup((call) => completed(call.args.outDir as string, "resp"));
    const first = await t.runner.send(request(null, "first"));
    await t.runner.send(request(null, "second"));
    if (!first.ok) throw new Error("the first send failed");

    const renamed = await renameSession(t.root, first.session.id, "first, renamed");
    expect(await order(t.root)).toEqual(["second", "first, renamed"]);

    // Drafts and attachments live in the window until sent (the UI state and the
    // image registry), never in a session; even a session file written or touched
    // later than the others leaves the order to its turns.
    const future = new Date(Date.UTC(2030, 0, 1));
    utimesSync(join(t.root, renamed.id, "session.json"), future, future);
    utimesSync(join(t.root, renamed.id), future, future);
    expect(await order(t.root)).toEqual(["second", "first, renamed"]);
  });
});
