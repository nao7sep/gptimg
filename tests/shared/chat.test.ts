import { describe, expect, it } from "vitest";
import {
  fileStamp,
  folderPart,
  folderStamp,
  historyBefore,
  parseChat,
  previousResponseBefore,
  chatTotals,
  titleFrom,
  type Turn,
} from "../../src/shared/chat.ts";

const user = (id: string, text: string, images: string[] = []): Turn => ({ id, role: "user", at: "2026-10-19T00:00:00.000Z", text, images, options: { size: "auto", quality: "auto" } });
const reply = (id: string, responseId: string, images: string[] = [], input = 10, output = 20): Turn => ({
  id,
  role: "assistant",
  at: "2026-10-19T00:00:01.000Z",
  text: "ok",
  images,
  responseId,
  resumed: null,
  incomplete: null,
  usage: { input, output },
  failedImages: 0,
});

describe("chat naming", () => {
  it("stamps names in UTC", () => {
    expect(fileStamp(new Date("2026-10-19T03:04:05.678Z"))).toBe("20261019-030405-utc");
    expect(folderStamp("20261019-030405-utc-Cats")).toBe("20261019-030405-utc");
  });

  it("titles a chat with the first message's opening words, marking a cut", () => {
    expect(titleFrom("  A cat\non a   windowsill ")).toBe("A cat on a windowsill");
    expect(titleFrom("one two three four five six seven eight nine ten")).toBe("one two three four five six seven eight");
    expect(titleFrom("x".repeat(80)).endsWith("…")).toBe(true);
  });

  it("makes a folder part safe on macOS and Windows", () => {
    expect(folderPart('a/b\\c:d*e?"f<g>h|i')).toBe("a b c d e f g h i");
    expect(folderPart("trailing dots...")).toBe("trailing dots");
    expect(folderPart("   ")).toBe("chat");
  });
});

describe("the history a turn sends", () => {
  const turns = [user("u1", "first"), reply("a1", "resp_1", ["a.png"]), user("u2", "failed"), user("u3", "again"), reply("a3", "resp_3")];

  it("leaves out a user turn that was never answered", () => {
    const history = historyBefore(turns, 3, (rel) => `/s/${rel}`);
    expect(history.map((t) => t.text)).toEqual(["first", "ok"]);
    expect(history[1]!.images).toEqual(["/s/a.png"]);
  });

  it("chains from the last reply before the turn", () => {
    expect(previousResponseBefore(turns, 3)).toBe("resp_1");
    expect(previousResponseBefore(turns, 0)).toBeUndefined();
  });

  it("totals images and tokens over the replies", () => {
    expect(chatTotals(turns)).toEqual({ images: 1, tokens: 60 });
  });
});

describe("chat.json validation", () => {
  const doc = { format: 1, id: "c1", title: "t", createdAt: "2026-10-19T00:00:00.000Z", turns: [user("u1", "hi", ["inputs/a.png"])] };

  it("accepts a well-formed chat", () => {
    expect(parseChat(doc)).not.toBeNull();
  });

  it("refuses image paths that leave the chat folder", () => {
    for (const path of ["/etc/passwd", "../other/a.png", "inputs/../../a.png", "C:\\x.png"]) {
      expect(parseChat({ ...doc, turns: [user("u1", "hi", [path])] })).toBeNull();
    }
  });

  it("refuses another format", () => {
    expect(parseChat({ ...doc, format: 2 })).toBeNull();
  });
});



describe("chat consumed-field validation", () => {
  const doc = { format: 1, id: "c1", title: "t", createdAt: "2026-10-19T00:00:00.000Z", turns: [reply("a", "r")] };

  it("rejects invalid timestamps and accepts supported UTC precision", () => {
    for (const createdAt of ["tomorrow", "2026-02-30T00:00:00Z", "2026-10-19T00:00:00+09:00"]) {
      expect(parseChat({ ...doc, createdAt })).toBeNull();
    }
    for (const createdAt of ["2026-10-19T00:00:00Z", "2026-10-19T00:00:00.1234567+00:00"]) {
      expect(parseChat({ ...doc, createdAt })).not.toBeNull();
    }
  });

  it("validates all assistant values used by the app", () => {
    for (const fields of [
      { resumed: "other" }, { resumed: undefined }, { incomplete: 1 }, { incomplete: undefined },
      { failedImages: -1 }, { failedImages: 1.5 }, { blockedImages: -1 }, { missingImages: NaN },
      { usage: { input: "10", output: 2 } }, { usage: { input: 1, output: Infinity } },
      { usage: { input: 1, output: 2, imageOutput: -1 } }, { usage: undefined },
      { at: "invalid" },
    ]) expect(parseChat({ ...doc, turns: [{ ...reply("a", "r"), ...fields }] })).toBeNull();
  });

  it("preserves optionals and unknown fields", () => {
    const value = { ...doc, extra: "kept", turns: [user("u", "old"), { ...reply("a", "r"), usage: { input: 0, output: 0, extra: 5 } }] };
    expect(parseChat(value)).toBe(value);
  });

  it("validates masks and backgrounds as well as image references", () => {
    for (const fields of [ { mask: "../escape.png" }, { mask: "C:\\x.png" }, { mask: 3 }, { options: { size: "auto", quality: "auto", background: "auto" } } ]) {
      expect(parseChat({ ...doc, turns: [{ ...user("u", "x"), ...fields }] })).toBeNull();
    }
    expect(parseChat({ ...doc, turns: [{ ...user("u", "x"), mask: "inputs/mask.png", options: { size: "auto", quality: "auto", background: "opaque" } }] })).not.toBeNull();
  });
});
