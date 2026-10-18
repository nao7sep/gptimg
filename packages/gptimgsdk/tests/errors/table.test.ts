// The error model (sdk-conventions, *Errors*): one table owns every code and its
// kind, errors carry code, kind, effect, subject and details, and they cross
// process boundaries as plain data a guard recognizes.
import { describe, expect, it } from "vitest";
import {
  ERROR_CODES,
  ERROR_EFFECTS,
  ERROR_KINDS,
  GptImgError,
  cancelledError,
  fsError,
  isGptImgErrorData,
} from "../../src/errors.ts";
import { REFUSAL_CODES } from "../../src/refusal.ts";

describe("ERROR_CODES", () => {
  it("gives every code one of the four kinds, and no code is also a refusal", () => {
    for (const [code, kind] of Object.entries(ERROR_CODES)) {
      expect(ERROR_KINDS, code).toContain(kind);
      expect(REFUSAL_CODES as readonly string[], code).not.toContain(code);
    }
    expect(ERROR_EFFECTS).toEqual(["none", "unknown"]);
  });

  it("round-trips every code through toJSON and isGptImgErrorData", () => {
    for (const code of Object.keys(ERROR_CODES) as Array<keyof typeof ERROR_CODES>) {
      const err = new GptImgError(code, `boom ${code}`, {
        cause: Object.assign(new Error("inner"), { code: "EIO" }),
        effect: "unknown",
        subject: "/x/y.png",
        details: { field: "in" },
      });
      const data = JSON.parse(JSON.stringify(err)) as unknown;
      expect(isGptImgErrorData(data), code).toBe(true);
      expect(data).toEqual({
        name: "GptImgError",
        code,
        kind: ERROR_CODES[code],
        effect: "unknown",
        message: `boom ${code}`,
        subject: "/x/y.png",
        details: { field: "in" },
        cause: { name: "Error", message: "inner", code: "EIO" },
      });
      expect(isGptImgErrorData(err)).toBe(true);
    }
  });

  it("rejects shapes that only look like the error's", () => {
    expect(isGptImgErrorData({ name: "GptImgError", code: "made.up", kind: "invalid", effect: "none", message: "x" })).toBe(false);
    expect(isGptImgErrorData({ name: "GptImgError", code: "args.invalid", kind: "internal", effect: "none", message: "x" })).toBe(false);
    expect(isGptImgErrorData({ name: "GptImgError", code: "args.invalid", kind: "invalid", effect: "maybe", message: "x" })).toBe(false);
    expect(isGptImgErrorData(new Error("x"))).toBe(false);
    expect(isGptImgErrorData(null)).toBe(false);
  });
});

describe("error helpers", () => {
  it("name filesystem failures by the cause the system reported", () => {
    const cases: Array<[string, string]> = [
      ["ENOENT", "fs.notFound"],
      ["EACCES", "fs.permissionDenied"],
      ["EPERM", "fs.permissionDenied"],
      ["ENOSPC", "fs.noSpace"],
      ["EROFS", "fs.readOnly"],
      ["EBUSY", "fs.busy"],
      ["EMFILE", "fs.tooManyOpenFiles"],
      ["EIO", "fs.failed"],
    ];
    for (const [errno, code] of cases) {
      const err = fsError(Object.assign(new Error(errno), { code: errno, syscall: "open" }), "Failed to read", "/x/a.png", "unknown");
      expect(err, errno).toMatchObject({ code, kind: "unavailable", effect: "unknown", subject: "/x/a.png", details: { errno, syscall: "open" } });
    }
  });

  it("makes cancellation an error of kind cancelled whose effect the caller sets from evidence", () => {
    expect(cancelledError(new Error("stop"))).toMatchObject({ code: "cancelled", kind: "cancelled", effect: "none", message: "stop" });
    const paid = cancelledError(cancelledError("stop"), "unknown");
    expect(paid).toMatchObject({ code: "cancelled", effect: "unknown" });
  });
});
