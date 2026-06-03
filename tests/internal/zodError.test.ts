import { describe, expect, it } from "vitest";
import { z } from "zod";
import { formatZodError } from "../../src/internal/zodError.js";

describe("formatZodError", () => {
  it("joins nested issues as 'path: message' segments", () => {
    const schema = z.object({ a: z.string(), b: z.object({ c: z.number() }) });
    const r = schema.safeParse({ a: 1, b: { c: "x" } });
    expect(r.success).toBe(false);
    const msg = formatZodError(r.error!);
    expect(msg).toContain("a:");
    expect(msg).toContain("b.c:");
    expect(msg).toContain("; ");
  });

  it("labels a root-level issue as <root>", () => {
    const r = z.string().safeParse(123);
    expect(r.success).toBe(false);
    const msg = formatZodError(r.error!);
    expect(msg.startsWith("<root>:")).toBe(true);
  });
});
