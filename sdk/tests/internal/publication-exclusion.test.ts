import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GptImg } from "../../src/gptimg.ts";
import { publishFileNoClobber } from "../../src/internal/atomic-file.ts";

const edges = vi.hoisted(() => ({ link: vi.fn(), rename: vi.fn(), realpath: vi.fn(), generate: vi.fn(), namespace: undefined as Map<string, Buffer> | undefined }));
vi.mock("node:fs/promises", async (load) => {
  const actual = await load<typeof import("node:fs/promises")>();
  const path = await import("node:path");
  return { ...actual, link: edges.link,
    // The late-admission tests emulate only the target namespace. Real staging,
    // encoded bytes and directory durability still use the disposable folder.
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      const entries = await actual.readdir(...args);
      if (!edges.namespace) return entries;
      return [...entries, ...[...edges.namespace.keys()].map((file) => path.basename(file))];
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (edges.namespace && String(args[0]).endsWith(".png")) {
        if (!edges.namespace.has(String(args[0]))) throw Object.assign(new Error("missing exact name"), { code: "ENOENT" });
        return {};
      }
      return actual.lstat(...args);
    }, realpath: async (...args: Parameters<typeof actual.realpath>) => {
    await edges.realpath(...args);
    return actual.realpath(...args);
  }, rename: async (...args: Parameters<typeof actual.rename>) => {
    await edges.rename(...args);
    if (edges.namespace && String(args[1]).endsWith(".png")) {
      edges.namespace.set(String(args[1]), await actual.readFile(args[0]));
      await actual.unlink(args[0]);
      return;
    }
    return actual.rename(...args);
  } };
});
vi.mock("../../src/providers/index.ts", () => ({ getProvider: () => ({ name: "openai", generate: edges.generate }) }));
let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "gptimg-publication-"));
  edges.namespace = undefined;
  edges.link.mockReset();
  edges.rename.mockReset();
  edges.realpath.mockReset();
  edges.generate.mockReset();
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}
function holdFirstLink() {
  const entered = deferred();
  const release = deferred();
  edges.link.mockImplementation(async () => {
    if (edges.link.mock.calls.length === 1) {
      entered.resolve();
      await release.promise;
    }
    throw Object.assign(new Error("no hardlinks"), { code: "ENOTSUP" });
  });
  return { entered: entered.promise, release: () => release.resolve() };
}
it.each(["same", "lexical", "symlink", "case", "unicode"])("excludes a competing no-overwrite publication through %s identity", async (alias) => {
  const real = path.join(tmp, "real");
  await mkdir(real);
  const aliasDir = path.join(tmp, "alias");
  await symlink(real, aliasDir, process.platform === "win32" ? "junction" : "dir");
  const target = path.join(real, "caf\u00e9.txt");
  const other = alias === "lexical" ? `${real}/../real/caf\u00e9.txt`
    : alias === "symlink" ? path.join(aliasDir, "caf\u00e9.txt")
    : alias === "case" ? path.join(real, "CAF\u00c9.TXT")
    : alias === "unicode" ? path.join(real, "cafe\u0301.txt") : target;
  const a = path.join(real, "a.tmp");
  const b = path.join(real, "b.tmp");
  await writeFile(a, "first complete bytes");
  await writeFile(b, "second complete bytes");
  const gate = holdFirstLink();
  const first = publishFileNoClobber(a, target).then(value => ({ value }), error => ({ error }));
  await gate.entered;
  let second;
  try {
    [second] = await Promise.allSettled([publishFileNoClobber(b, other)]);
  } finally { gate.release(); }
  const firstResult = await first;
  expect(second).toMatchObject({ status: "rejected", reason: { code: "EEXIST" } });
  expect(firstResult).toEqual({ value: { tempRemains: false } });
  expect(await readFile(target, "utf8")).toBe("first complete bytes");
  await rm(target);
  await expect(publishFileNoClobber(b, other)).resolves.toEqual({ tempRemains: false });
});
it.each(["local", "paid"])("keeps the first local output when a competing %s publisher reaches the fallback", async (competitor) => {
  const sdk = new GptImg({ apiKey: "sk-offline" });
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#ff0000" } }).png().toBuffer();
  edges.generate.mockResolvedValue({ raw: {}, images: [{ data: png }] });
  const gate = holdFirstLink();
  const first = sdk.backplate({ outDir: tmp, outName: "same", size: 8, from: "#000000", to: "#000000" })
    .then(value => ({ value }), error => ({ error }));
  await gate.entered;
  let second;
  try {
    second = competitor === "local"
      ? await sdk.backplate({ outDir: tmp, outName: "same", size: 8, from: "#ffffff", to: "#ffffff" })
      : await sdk.generate({ outDir: tmp, outName: "same", prompt: "offline" });
  } finally { gate.release(); }
  const firstResult = await first;
  expect(firstResult).toMatchObject({ value: { status: "completed" } });
  if (competitor === "local") {
    expect(second).toMatchObject({ status: "refused", refusal: { code: "output.exists" } });
  } else {
    expect(second).toMatchObject({ status: "completed", failures: [{ code: "output.exists" }] });
  }
  const { data } = await sharp(path.join(tmp, "same.png")).raw().toBuffer({ resolveWithObject: true });
  expect([...data.slice(0, 3)]).toEqual([0, 0, 0]);
  expect(await readdir(tmp)).toEqual(["same.png"]);
});

// Pause after the absence check, exactly where two fallback writers could
// previously both succeed and the first rename could replace the second.
it("prevents two successful fallback renames after the first absence check", async () => {
  const a = path.join(tmp, "a.tmp");
  const b = path.join(tmp, "b.tmp");
  const target = path.join(tmp, "race.txt");
  await writeFile(a, "first complete bytes");
  await writeFile(b, "second complete bytes");
  edges.link.mockRejectedValue(Object.assign(new Error("no hardlinks"), { code: "ENOTSUP" }));
  const entered = deferred();
  const release = deferred();
  edges.rename.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
  });
  const first = publishFileNoClobber(a, target).then(value => ({ value }), error => ({ error }));
  await entered.promise;
  let second;
  try {
    [second] = await Promise.allSettled([publishFileNoClobber(b, target)]);
  } finally { release.resolve(); }
  expect(await first).toEqual({ value: { tempRemains: false } });
  expect(second).toMatchObject({ status: "rejected", reason: { code: "EEXIST" } });
  expect(await readFile(target, "utf8")).toBe("first complete bytes");
  expect(edges.rename).toHaveBeenCalledOnce();
});

it("releases a failed publication claim without blocking an independent target", async () => {
  const temp = path.join(tmp, "missing.tmp");
  const target = path.join(tmp, "target.txt");
  edges.link.mockRejectedValue(Object.assign(new Error("no hardlinks"), { code: "ENOTSUP" }));
  await expect(publishFileNoClobber(temp, target)).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(temp, "recovered");
  await expect(publishFileNoClobber(temp, target)).resolves.toEqual({ tempRemains: false });
  const independent = path.join(tmp, "other.tmp");
  await writeFile(independent, "independent");
  await expect(publishFileNoClobber(independent, path.join(tmp, "other.txt"))).resolves.toEqual({ tempRemains: false });
});

it("lets unrelated targets publish while the first target is still held", async () => {
  const a = path.join(tmp, "a.tmp");
  const b = path.join(tmp, "b.tmp");
  await writeFile(a, "first");
  await writeFile(b, "independent");
  const gate = holdFirstLink();
  const first = publishFileNoClobber(a, path.join(tmp, "a.txt"));
  await gate.entered;
  try {
    await expect(publishFileNoClobber(b, path.join(tmp, "b.txt"))).resolves.toEqual({ tempRemains: false });
    expect(await readFile(path.join(tmp, "b.txt"), "utf8")).toBe("independent");
  } finally { gate.release(); }
  await expect(first).resolves.toEqual({ tempRemains: false });
});

// Both verbs pass preflight while the directory is empty. The second reaches
// common publication only after the first publisher has settled its claim.
it.each([["Photo", "photo"], ["caf\u00e9", "cafe\u0301"]])("refuses a late portable alias %s / %s after both preflights pass", async (firstName, secondName) => {
  const sdk = new GptImg();
  // Exact-name keys model a case/normalization-sensitive volume even when the
  // test host folds those names. Both SDK results and published bytes are real.
  edges.namespace = new Map<string, Buffer>();
  const firstLink = holdFirstLink();
  const secondAdmitted = deferred();
  const secondRelease = deferred();
  edges.realpath.mockImplementation(async () => {
    if (edges.realpath.mock.calls.length === 2) {
      secondAdmitted.resolve();
      await secondRelease.promise;
    }
  });
  const first = sdk.backplate({ outDir: tmp, outName: firstName, size: 8, from: "#000000", to: "#000000" });
  await firstLink.entered;
  const second = sdk.backplate({ outDir: tmp, outName: secondName, size: 8, from: "#ffffff", to: "#ffffff" });
  await secondAdmitted.promise;
  firstLink.release();
  let firstResult;
  try { firstResult = await first; } finally { secondRelease.resolve(); }
  const secondResult = await second;
  expect(firstResult).toMatchObject({ status: "completed" });
  expect(secondResult).toMatchObject({ status: "refused", refusal: { code: "output.exists" } });
  expect(edges.namespace.size).toBe(1);
  expect([...edges.namespace.keys()]).toEqual([path.join(tmp, `${firstName}.png`)]);
  expect(await readdir(tmp)).toHaveLength(1);
  const { data } = await sharp(edges.namespace.get(path.join(tmp, `${firstName}.png`))!).raw().toBuffer({ resolveWithObject: true });
  expect([...data.slice(0, 3)]).toEqual([0, 0, 0]);
});
