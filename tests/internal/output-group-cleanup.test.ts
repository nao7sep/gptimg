import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIDECAR_FORMAT_VERSION } from "../../src/format-versions.js";

const newerWriter = vi.hoisted(() => ({
  afterUnlink: undefined as string | undefined,
  sidecar: "",
  bytes: "",
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    unlink: async (filePath: string): Promise<void> => {
      await actual.unlink(filePath);
      if (filePath === newerWriter.afterUnlink) {
        newerWriter.afterUnlink = undefined;
        await actual.writeFile(newerWriter.sidecar, newerWriter.bytes);
      }
    },
  };
});

import { createOutputGroup, ownedSlotFiles, removeUnpublishedSlots } from "../../src/internal/output-group.js";

describe("unpublished output cleanup", () => {
  let tmp: string;
  const current = JSON.stringify({ formatVersion: SIDECAR_FORMAT_VERSION, request: {}, response: {}, files: [] });
  const newer = JSON.stringify({ formatVersion: SIDECAR_FORMAT_VERSION + 1, future: true });

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "gptimg-group-cleanup-"));
  });

  afterEach(async () => {
    newerWriter.afterUnlink = undefined;
    await rm(tmp, { recursive: true, force: true });
  });

  it.each(["jpg", "png"])("preserves a newer sidecar and its %s image present at cleanup admission", async (extension) => {
    const image = path.join(tmp, `result.${extension}`);
    const sidecar = path.join(tmp, "result.json");
    await writeFile(image, "old image");
    await writeFile(sidecar, newer);
    const group = createOutputGroup(tmp, "result", "png");

    await expect(removeUnpublishedSlots(group, ownedSlotFiles(group, 1, 1), [])).rejects.toMatchObject({
      code: "sidecar.newerFormat",
    });
    expect(await readFile(image, "utf-8")).toBe("old image");
    expect(await readFile(sidecar, "utf-8")).toBe(newer);
  });

  it("rechecks a sidecar replaced by a newer producer between cleanup leaves", async () => {
    for (const slot of [1, 2]) {
      await writeFile(path.join(tmp, `result-${slot}.jpg`), `old image ${slot}`);
      await writeFile(path.join(tmp, `result-${slot}.json`), current);
    }
    const published = [path.join(tmp, "result-1.png"), path.join(tmp, "result-1.json")];
    await writeFile(published[0]!, "published image");
    newerWriter.afterUnlink = path.join(tmp, "result-1.jpg");
    newerWriter.sidecar = path.join(tmp, "result-2.json");
    newerWriter.bytes = newer;
    const group = createOutputGroup(tmp, "result", "png");

    await expect(removeUnpublishedSlots(group, ownedSlotFiles(group, 2, 2), published)).rejects.toMatchObject({
      code: "sidecar.newerFormat",
    });
    expect(await readFile(newerWriter.sidecar, "utf-8")).toBe(newer);
    expect(await readFile(path.join(tmp, "result-2.jpg"), "utf-8")).toBe("old image 2");
    expect(await readFile(published[0]!, "utf-8")).toBe("published image");
    expect(await readdir(tmp)).toEqual(["result-1.json", "result-1.png", "result-2.jpg", "result-2.json"]);
  });

  it("retains sidecar authority while removing images whose extension sorts after JSON", async () => {
    const sidecar = path.join(tmp, "result.json");
    const firstImage = path.join(tmp, "result.jpg");
    const secondImage = path.join(tmp, "result.png");
    await writeFile(sidecar, current);
    await writeFile(firstImage, "old JPEG");
    await writeFile(secondImage, "old PNG");
    newerWriter.afterUnlink = firstImage;
    newerWriter.sidecar = sidecar;
    newerWriter.bytes = newer;
    const group = createOutputGroup(tmp, "result", "png");

    await expect(removeUnpublishedSlots(group, ownedSlotFiles(group, 1, 1), [])).rejects.toMatchObject({
      code: "sidecar.newerFormat",
    });
    expect(await readFile(sidecar, "utf-8")).toBe(newer);
    expect(await readFile(secondImage, "utf-8")).toBe("old PNG");
  });

  it("removes current-format unused slots while retaining published and derived outputs", async () => {
    for (const name of ["result-1.png", "result-2.jpg", "result-mask.png"]) await writeFile(path.join(tmp, name), name);
    for (const name of ["result-1.json", "result-2.json"]) await writeFile(path.join(tmp, name), current);
    const group = createOutputGroup(tmp, "result", "png");
    await removeUnpublishedSlots(group, ownedSlotFiles(group, 2, 2), [path.join(tmp, "result-1.png"), path.join(tmp, "result-1.json")]);
    expect(await readdir(tmp)).toEqual(["result-1.json", "result-1.png", "result-mask.png"]);
  });
});
