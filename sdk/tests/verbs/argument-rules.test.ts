// The rules every verb shares, checked across verbs so they cannot drift apart:
// an unknown argument is refused, a path error names the bare field, a missing
// input is the filesystem's cause, and a policy is checked whole where it is given.
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GptImg, isGptImgErrorData } from "../../src/index.ts";
import { done } from "../helpers/results.ts";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "green-disk.png");

describe("arguments every verb shares", () => {
  let tmp: string;
  let sdk: GptImg;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-arg-rules-"));
    sdk = new GptImg({ modelsDir: path.join(tmp, "models") });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it.each([
    ["trim", () => sdk.trim({ in: FIXTURE, outDir: tmp, modelsDir: tmp } as never), "modelsDir"],
    ["icon", () => sdk.icon({ in: FIXTURE, outDir: tmp, outName: "x" } as never), "outName"],
    ["framecheck", () => sdk.framecheck({ in: FIXTURE, overwrite: true } as never), "overwrite"],
    ["verify", () => sdk.verify({ in: FIXTURE, outDir: tmp } as never), "outDir"],
  ])("%s refuses an argument it does not take, naming it, before any work", async (_verb, call, field) => {
    await expect(call()).rejects.toMatchObject({ code: "args.invalid", details: { field, constraint: "known argument" } });
  });

  it("refuses a retired argument with a hint at where its value now goes", async () => {
    await expect(sdk.trim({ in: FIXTURE, outDir: tmp, recipe: "/r.json" } as never)).rejects.toMatchObject({
      code: "args.invalid",
      message: expect.stringContaining("policy"),
      details: { field: "recipe", constraint: "retired" },
    });
  });

  it("names the bare field of a relative path, with the verb in the message only", async () => {
    await expect(sdk.trim({ in: "relative.png", outDir: tmp })).rejects.toMatchObject({
      message: expect.stringMatching(/^trim: in must be an absolute path/),
      details: { field: "in", constraint: "absolute path" },
    });
    await expect(sdk.grid({ inputs: [FIXTURE, "b.png"], outDir: tmp })).rejects.toMatchObject({
      details: { field: "inputs[1]" },
    });
  });

  it.each([
    ["trim", (missing: string) => sdk.trim({ in: missing, outDir: tmp })],
    ["despeckle", (missing: string) => sdk.despeckle({ in: missing, outDir: tmp })],
    ["keycheck", (missing: string) => sdk.keycheck({ in: missing, key: "#00ff00" })],
    ["shadow", (missing: string) => sdk.shadow({ in: missing, outDir: tmp })],
    ["resize", (missing: string) => sdk.resize({ in: missing, toSize: 8, outDir: tmp })],
  ])("%s reports a missing input as fs.notFound naming the file", async (_verb, call) => {
    const missing = path.join(tmp, "nope.png");
    await expect(call(missing)).rejects.toMatchObject({ code: "fs.notFound", kind: "unavailable", subject: missing });
  });

  it("checks a policy whole where it is given: constructor and call", async () => {
    const invalid = { code: "policy.invalid", details: { section: "chrome" } };
    expect(() => new GptImg({ policy: { chrome: {} } as never })).toThrow(
      expect.objectContaining({ code: "policy.invalid", details: expect.objectContaining({ section: "chrome" }) }),
    );
    await expect(sdk.mask({ in: FIXTURE, outDir: tmp, policy: { chrome: {} } as never })).rejects.toMatchObject(invalid);
    await expect(sdk.mask({ in: FIXTURE, outDir: tmp, policy: { chroma: { colour: "#00ff00" } } as never })).rejects.toMatchObject({
      code: "policy.invalid",
      details: { section: "chroma" },
    });
  });

  it("verify stops when its signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sdk.verify({ in: FIXTURE }, { signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
  });

  it("model.list reports a models folder it cannot read as a typed error, and each model's download size", async () => {
    expect(sdk.model.list().models.every((m) => typeof m.downloadBytes === "number" && m.downloadBytes > 0)).toBe(true);
    const notAFolder = path.join(tmp, "file");
    await writeFile(notAFolder, "x");
    let thrown: unknown;
    try {
      sdk.model.list({ modelsDir: notAFolder });
    } catch (err) {
      thrown = err;
    }
    expect(isGptImgErrorData((thrown as { toJSON(): unknown }).toJSON())).toBe(true);
    expect(thrown).toMatchObject({ kind: "unavailable", subject: expect.stringContaining(notAFolder) });
  });

  it("generate needs a destination: a folder or an absolute stem", async () => {
    await expect(new GptImg({ apiKey: "sk-test" }).generate({ prompt: "x" })).rejects.toMatchObject({
      code: "args.invalid",
      details: { field: "outDir" },
    });
    expect(done(await sdk.resize({ in: FIXTURE, toSize: 8, outName: path.join(tmp, "abs") })).output).toBe(path.join(tmp, "abs.png"));
  });
});
