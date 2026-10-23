import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import fc from "fast-check";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { imageFileName, indexWidth } from "../../src/internal/output-naming.ts";
import { createOutputGroup, reserveOutputGroup, siblingsOnDisk } from "../../src/internal/output-group.ts";
import { RefusalSignal } from "../../src/refusal.ts";
import { computeAlphaBBox, runTrim } from "../../src/local/trim.ts";
import { despeckleRGBA } from "../../src/local/despeckle.ts";
import { runCombine } from "../../src/local/combine.ts";
import { chromaMask } from "../../src/local/chroma/mask.ts";
import { analyzeKey, SRGB_TO_LINEAR_LUT } from "../../src/local/chroma/spill.ts";
import { nullBase64InResponse } from "../../src/sidecar/nullBase64.ts";
import { maskUrlQuery } from "../../src/events/mask.ts";

/**
 * Invariants of the SDK's pure rules, checked against generated inputs
 * (fast-check). Each property states a guarantee the code documents; a failure
 * prints a shrunk counterexample. Pixel properties use images up to 12x12 and
 * small run counts so the file stays a few seconds long.
 */

let tmp: string;
let seq = 0;
/** A fresh file path inside the shared temp dir, unique across runs. */
function fresh(name: string): string {
  seq++;
  return path.join(tmp, `${seq}-${name}`);
}

beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "gptimg-invariants-"));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

// ----- generators -----

const dim = fc.integer({ min: 1, max: 12 });

/** A tiny RGBA image of arbitrary bytes. */
const rgbaImage = fc
  .tuple(dim, dim)
  .chain(([width, height]) =>
    fc
      .uint8Array({ minLength: width * height * 4, maxLength: width * height * 4 })
      .map((data) => ({ width, height, data })),
  );

/** A tiny RGBA image whose alpha is sparse: mostly 0, otherwise any value. */
const sparseAlphaImage = fc.tuple(dim, dim).chain(([width, height]) =>
  fc
    .array(
      fc.record({
        rgb: fc.tuple(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 })),
        alpha: fc.oneof({ weight: 2, arbitrary: fc.constant(0) }, { weight: 1, arbitrary: fc.integer({ min: 1, max: 255 }) }),
      }),
      { minLength: width * height, maxLength: width * height },
    )
    .map((pixels) => {
      const data = new Uint8Array(width * height * 4);
      pixels.forEach(({ rgb, alpha }, p) => data.set([...rgb, alpha], p * 4));
      return { width, height, data };
    }),
);

/** A tiny single-channel mask. */
const maskImage = fc
  .tuple(dim, dim)
  .chain(([width, height]) =>
    fc.uint8Array({ minLength: width * height, maxLength: width * height }).map((data) => ({ width, height, data })),
  );

async function writeRgba(file: string, img: { width: number; height: number; data: Uint8Array }): Promise<void> {
  await sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels: 4 } }).png().toFile(file);
}

async function writeMask(file: string, img: { width: number; height: number; data: Uint8Array }): Promise<void> {
  await sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels: 1 } }).png().toFile(file);
}

async function readRgba(file: string): Promise<{ width: number; height: number; data: Uint8Array }> {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

async function readMask(file: string): Promise<Uint8Array> {
  return new Uint8Array(await sharp(file).grayscale().removeAlpha().raw().toBuffer());
}

// ----- output naming -----

describe("output naming and slot padding", () => {
  const stem = fc.string({ maxLength: 12 });
  const extension = fc.stringMatching(/^[a-z0-9]{1,5}$/);

  it("names every slot of a run uniquely, pads to one width and keeps the stem and extension", () => {
    fc.assert(
      fc.property(stem, extension, fc.integer({ min: 1, max: 1500 }), (s, ext, n) => {
        const names = Array.from({ length: n }, (_, i) => imageFileName(s, i + 1, n, ext));
        expect(new Set(names).size).toBe(n);
        expect(indexWidth(n)).toBe(String(n).length);
        if (n === 1) {
          expect(names[0]).toBe(`${s}.${ext}`);
          return;
        }
        // Plain comparisons per name and one assertion per run: up to 1,500 names a run,
        // and an expect() per name made the property cost seconds.
        const width = indexWidth(n);
        const wrong = names.filter((name, i) => {
          const digits = name.slice(s.length + 1, name.length - ext.length - 1);
          return !name.startsWith(`${s}-`) || !name.endsWith(`.${ext}`) || !/^\d+$/.test(digits) || digits.length !== width || Number(digits) !== i + 1;
        });
        expect(wrong).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });
});

// ----- output group membership -----

/**
 * Letters whose case and NFC/NFD spellings differ, plus the characters that
 * build `<stem>-<digits>` slots. Characters whose case mapping changes length
 * or crosses into ASCII (ß, İ, the Kelvin sign) are left out: their case
 * folding is a separate question from the one these properties ask.
 */
const STEM_CHARS = ["a", "b", "x", "Z", "1", "2", "-", "_", "é", "ñ", "ü", "Å", "ç"];
const stemArb = fc.array(fc.constantFrom(...STEM_CHARS), { minLength: 1, maxLength: 6 }).map((cs) => cs.join(""));

/** The same name respelled: each character's case flipped or kept, then NFC or NFD. */
function respell(stem: string): fc.Arbitrary<string> {
  return fc
    .tuple(fc.array(fc.boolean(), { minLength: stem.length, maxLength: stem.length }), fc.constantFrom("NFC", "NFD"))
    .map(([flips, form]) =>
      [...stem]
        .map((c, i) => (flips[i] ? (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()) : c))
        .join("")
        .normalize(form),
    );
}

const fold = (s: string): string => s.normalize("NFC").toLowerCase();
/** Reference rule: `name` is a slot of `stem` (the stem itself or `<stem>-<digits>`), after folding. */
const isSlotRef = (name: string, stem: string): boolean =>
  fold(name) === fold(stem) || (fold(name).startsWith(`${fold(stem)}-`) && /^\d+$/.test(fold(name).slice(fold(stem).length + 1)));

async function reservationRefusal(dir: string, held: string, next: string): Promise<string | null> {
  const first = await reserveOutputGroup(createOutputGroup(dir, held, "png"));
  try {
    const second = await reserveOutputGroup(createOutputGroup(dir, next, "png"));
    second.release();
    return null;
  } catch (err) {
    if (err instanceof RefusalSignal) return err.code;
    throw err;
  } finally {
    first.release();
  }
}

describe("case-folded NFC group membership", () => {
  it("treats a case or NFC/NFD respelling of a stem as the same group member", async () => {
    await fc.assert(
      fc.asyncProperty(
        stemArb.chain((s) => fc.tuple(fc.constant(s), respell(s))),
        fc.integer({ min: 1, max: 120 }),
        async ([stem, variant], index) => {
          const dir = await mkdtemp(path.join(tmp, "group-"));
          // A live run holding one spelling blocks the other spelling and its numbered slots.
          expect(await reservationRefusal(dir, stem, variant)).toBe("output.busy");
          expect(await reservationRefusal(dir, variant, stem)).toBe("output.busy");
          expect(await reservationRefusal(dir, stem, `${variant}-${index}`)).toBe("output.busy");
          // Files on disk spelled the other way are members of the group.
          const files = [`${variant}.png`, `${variant}-${index}.json`];
          for (const f of files) await writeFile(path.join(dir, f), "");
          const found = (await siblingsOnDisk(createOutputGroup(dir, stem, "png"))).map((p) => path.basename(p)).sort();
          expect(found).toEqual(files.map((f) => f).sort());
        },
      ),
      { numRuns: 60 },
    );
  });

  it("never merges stems that differ in more than case or Unicode spelling", async () => {
    await fc.assert(
      fc.asyncProperty(stemArb, stemArb, async (a, b) => {
        fc.pre(fold(a) !== fold(b));
        const dir = await mkdtemp(path.join(tmp, "distinct-"));
        // Distinct stems run side by side unless one is a numbered slot of the
        // other; that overlap is refused explicitly, never merged.
        const overlap = isSlotRef(a, b) || isSlotRef(b, a);
        expect(await reservationRefusal(dir, a, b)).toBe(overlap ? "output.busy" : null);
        await writeFile(path.join(dir, `${b}.png`), "");
        const found = await siblingsOnDisk(createOutputGroup(dir, a, "png"));
        expect(found.length).toBe(isSlotRef(b, a) ? 1 : 0);
      }),
      { numRuns: 80 },
    );
  });
});

// ----- trim -----

describe("trim", () => {
  it("keeps the input's alpha bounding box intact and pads it by exactly marginPx", async () => {
    await fc.assert(
      fc.asyncProperty(
        sparseAlphaImage,
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.boolean(),
        async (img, margin, square) => {
          const bbox = computeAlphaBBox(img.data, img.width, img.height);
          fc.pre(bbox !== null);
          const input = fresh("trim-in.png");
          const out = fresh("trim-out.png");
          await writeRgba(input, img);
          const res = await runTrim({ in: input, out, margin, square });
          const got = await readRgba(out);

          expect(res.bbox).toEqual(bbox);
          expect(res.marginPx).toBe(Math.round(margin * Math.max(bbox!.width, bbox!.height)));
          expect([got.width, got.height]).toEqual([res.width, res.height]);

          const outBox = computeAlphaBBox(got.data, got.width, got.height)!;
          expect([outBox.width, outBox.height]).toEqual([bbox!.width, bbox!.height]);
          const left = outBox.x;
          const top = outBox.y;
          const right = got.width - outBox.x - outBox.width;
          const bottom = got.height - outBox.y - outBox.height;
          if (square) {
            expect(got.width).toBe(got.height);
            expect(Math.min(left, right, top, bottom)).toBe(res.marginPx);
            expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
            expect(Math.abs(top - bottom)).toBeLessThanOrEqual(1);
          } else {
            expect([left, top, right, bottom]).toEqual([res.marginPx, res.marginPx, res.marginPx, res.marginPx]);
          }
          // Every input pixel inside the bbox lands unchanged at the same relative spot.
          for (let y = 0; y < bbox!.height; y++) {
            for (let x = 0; x < bbox!.width; x++) {
              const i = ((bbox!.y + y) * img.width + bbox!.x + x) * 4;
              const o = ((outBox.y + y) * got.width + outBox.x + x) * 4;
              expect(got.data[o + 3]).toBe(img.data[i + 3]);
              if (img.data[i + 3]! > 0) {
                expect([...got.data.subarray(o, o + 3)]).toEqual([...img.data.subarray(i, i + 3)]);
              }
            }
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});

// ----- despeckle -----

/** Reference component sizes over `alpha >= level`, by union-find. */
function componentSizes(alpha: (p: number) => number, width: number, height: number, level: number, connectivity: number) {
  const n = width * height;
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (p: number): number => {
    while (parent[p] !== p) p = parent[p] = parent[parent[p]!]!;
    return p;
  };
  const on = (p: number): boolean => alpha(p) >= level;
  const offsets = connectivity === 8 ? [[1, 0], [0, 1], [1, 1], [-1, 1]] : [[1, 0], [0, 1]];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (!on(p)) continue;
      for (const [dx, dy] of offsets) {
        const nx = x + dx!;
        const ny = y + dy!;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const q = ny * width + nx;
        if (on(q)) parent[find(p)] = find(q);
      }
    }
  }
  const size = new Map<number, number>();
  for (let p = 0; p < n; p++) if (on(p)) size.set(find(p), (size.get(find(p)) ?? 0) + 1);
  return { root: find, size };
}

describe("despeckle", () => {
  const options = fc.record({
    threshold: fc.integer({ min: 0, max: 255 }),
    minArea: fc.integer({ min: 0, max: 20 }),
    connectivity: fc.constantFrom(4, 8),
    keep: fc.constantFrom("all" as const, "largest" as const),
  });

  it("never raises alpha, never touches colour, and keeps every component at or above minArea", () => {
    fc.assert(
      fc.property(sparseAlphaImage, options, (img, opts) => {
        const res = despeckleRGBA(img.data, img.width, img.height, opts);
        const n = img.width * img.height;
        const level = Math.max(1, opts.threshold);
        const ref = componentSizes((p) => img.data[p * 4 + 3]!, img.width, img.height, level, opts.connectivity);
        for (let p = 0; p < n; p++) {
          const before = img.data[p * 4 + 3]!;
          const after = res.data[p * 4 + 3]!;
          expect(after).toBeLessThanOrEqual(before);
          // It only ever zeros alpha.
          expect(after === 0 || after === before).toBe(true);
          expect([...res.data.subarray(p * 4, p * 4 + 3)]).toEqual([...img.data.subarray(p * 4, p * 4 + 3)]);
          if (opts.keep === "all" && before >= level && ref.size.get(ref.root(p))! >= opts.minArea) {
            expect(after).toBe(before);
          }
        }
        // The caller's buffer is left alone.
        expect(res.data).not.toBe(img.data);
      }),
      { numRuns: 300 },
    );
  });
});

// ----- combine -----

describe("combine", () => {
  it("invert twice is the identity", async () => {
    await fc.assert(
      fc.asyncProperty(maskImage, async (img) => {
        const a = fresh("a.png");
        const once = fresh("inv1.png");
        const twice = fresh("inv2.png");
        await writeMask(a, img);
        await runCombine({ op: "invert", inputs: [a], out: once });
        await runCombine({ op: "invert", inputs: [once], out: twice });
        expect([...(await readMask(twice))]).toEqual([...img.data]);
      }),
      { numRuns: 25 },
    );
  });

  it("union and intersect are commutative", async () => {
    const pair = fc
      .tuple(dim, dim)
      .chain(([width, height]) =>
        fc
          .tuple(
            fc.uint8Array({ minLength: width * height, maxLength: width * height }),
            fc.uint8Array({ minLength: width * height, maxLength: width * height }),
          )
          .map(([a, b]) => ({ a: { width, height, data: a }, b: { width, height, data: b } })),
      );
    await fc.assert(
      fc.asyncProperty(pair, fc.constantFrom("union" as const, "intersect" as const), async ({ a, b }, op) => {
        const pa = fresh("a.png");
        const pb = fresh("b.png");
        const ab = fresh("ab.png");
        const ba = fresh("ba.png");
        await writeMask(pa, a);
        await writeMask(pb, b);
        await runCombine({ op, inputs: [pa, pb], out: ab });
        await runCombine({ op, inputs: [pb, pa], out: ba });
        const left = await readMask(ab);
        expect([...(await readMask(ba))]).toEqual([...left]);
        const pick = op === "union" ? Math.max : Math.min;
        expect([...left]).toEqual([...a.data].map((v, i) => pick(v, b.data[i]!)));
      }),
      { numRuns: 25 },
    );
  });
});

// ----- chroma masking -----

const byte = fc.integer({ min: 0, max: 255 });
const hexOf = ([r, g, b]: readonly number[]): string => `#${[r, g, b].map((v) => v!.toString(16).padStart(2, "0")).join("")}`;
const linear = ([r, g, b]: readonly number[]): [number, number, number] => [
  SRGB_TO_LINEAR_LUT[r!]!,
  SRGB_TO_LINEAR_LUT[g!]!,
  SRGB_TO_LINEAR_LUT[b!]!,
];

describe("chroma masking", () => {
  it("produces one alpha in 0..255 per pixel for any image and options", async () => {
    await fc.assert(
      fc.asyncProperty(
        rgbaImage,
        fc.record({
          key: fc.oneof(fc.constant("auto"), fc.tuple(byte, byte, byte).map(hexOf)),
          preserveInterior: fc.boolean(),
          borderSample: fc.integer({ min: 1, max: 6 }),
          saturationRatio: fc.double({ min: 0.01, max: 1, noNaN: true }),
        }),
        async (img, opts) => {
          const res = await chromaMask(img.data, img.width, img.height, opts);
          expect(res.alpha.length).toBe(img.width * img.height);
          for (const a of res.alpha) {
            expect(Number.isInteger(a) && a >= 0 && a <= 255).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("makes every pixel exactly equal to a chromatic key fully transparent", async () => {
    // The border ring is the key itself, so the border-strength refinement
    // measures the key, and preserveInterior is off so no interior key region
    // is deliberately restored. Achromatic keys are documented to leave the
    // image opaque, so only chromatic keys are generated.
    const key = fc.tuple(byte, byte, byte).filter((rgb) => analyzeKey(linear(rgb)) !== null);
    await fc.assert(
      fc.asyncProperty(rgbaImage, key, fc.constantFrom("explicit", "auto"), async (img, rgb, source) => {
        const data = img.data.slice();
        const keyPixel = (p: number): void => data.set([...rgb, 255], p * 4);
        for (let y = 0; y < img.height; y++) {
          for (let x = 0; x < img.width; x++) {
            if (x === 0 || y === 0 || x === img.width - 1 || y === img.height - 1) keyPixel(y * img.width + x);
          }
        }
        const res = await chromaMask(data, img.width, img.height, {
          key: source === "auto" ? "auto" : hexOf(rgb),
          preserveInterior: false,
          borderSample: 1,
        });
        expect(res.stats.key).toBe(hexOf(rgb));
        for (let p = 0; p < img.width * img.height; p++) {
          if (data[p * 4] === rgb[0] && data[p * 4 + 1] === rgb[1] && data[p * 4 + 2] === rgb[2]) {
            expect(res.alpha[p], `pixel ${p} equals the key ${hexOf(rgb)}`).toBe(0);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});

// ----- nullBase64InResponse -----

const BASE64_FIELDS = ["b64_json", "image_b64", "image_base64"];
const PAYLOAD_MARK = "QkFTRTY0UEFZTE9BRA";

/** Response-shaped JSON: objects mixing ordinary keys, base64 image fields and `url`s. */
const responseArb = fc.letrec<{ value: unknown }>((tie) => ({
  value: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.oneof(fc.string(), fc.integer(), fc.double({ noNaN: true }), fc.boolean(), fc.constant(null)),
    fc.array(tie("value"), { maxLength: 4 }),
    fc
      .array(
        fc.oneof(
          fc.tuple(fc.string({ maxLength: 8 }), tie("value")),
          fc.tuple(
            fc.constantFrom(...BASE64_FIELDS),
            fc.oneof(fc.base64String({ minLength: 4, maxLength: 40 }).map((b) => `${PAYLOAD_MARK}${b}`), tie("value")),
          ),
          fc.tuple(
            fc.constant("url"),
            fc.oneof(
              fc.webUrl({ withQueryParameters: true, withFragments: true }),
              fc.string(),
              tie("value"),
            ),
          ),
        ),
        { maxLength: 5 },
      )
      .map((entries) => {
        // Own data properties throughout, as JSON.parse builds them.
        const obj: Record<string, unknown> = {};
        for (const [k, v] of entries) Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true });
        return obj;
      }),
  ),
})).value;

/** Asserts `out` is `input` with only base64 fields nulled and url strings masked. */
function expectRecorded(input: unknown, out: unknown, where = "$"): void {
  if (Array.isArray(input)) {
    expect(Array.isArray(out), where).toBe(true);
    const arr = out as unknown[];
    expect(arr.length, where).toBe(input.length);
    input.forEach((v, i) => expectRecorded(v, arr[i], `${where}[${i}]`));
    return;
  }
  if (input !== null && typeof input === "object") {
    expect(out !== null && typeof out === "object" && !Array.isArray(out), where).toBe(true);
    const o = out as Record<string, unknown>;
    expect(Object.keys(o), where).toEqual(Object.keys(input));
    for (const [k, v] of Object.entries(input)) {
      const own = Object.getOwnPropertyDescriptor(o, k)?.value;
      if (BASE64_FIELDS.includes(k)) expect(own, `${where}.${k}`).toBeNull();
      else if (k === "url" && typeof v === "string") expect(own, `${where}.${k}`).toBe(maskUrlQuery(v));
      else expectRecorded(v, own, `${where}.${k}`);
    }
    return;
  }
  expect(Object.is(out, input), where).toBe(true);
}

describe("nullBase64InResponse", () => {
  it("keeps positions and other fields, nulls every base64 image field and leaves the input alone", () => {
    fc.assert(
      fc.property(responseArb, (response) => {
        const before = structuredClone(response);
        const out = nullBase64InResponse(response);
        expect(response).toEqual(before);
        expectRecorded(response, out);
        expect(JSON.stringify(out) ?? "").not.toContain(PAYLOAD_MARK);
      }),
      { numRuns: 500 },
    );
  });

  it("keeps response.data positions so data[i] still matches the saved file at index i + 1", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ b64_json: fc.base64String({ minLength: 4 }), revised_prompt: fc.string() }, { requiredKeys: ["revised_prompt"] }),
          { maxLength: 10 },
        ),
        fc.integer(),
        (data, created) => {
          const out = nullBase64InResponse({ created, data }) as { created: number; data: Array<Record<string, unknown>> };
          expect(out.created).toBe(created);
          expect(out.data.map((d) => d.revised_prompt)).toEqual(data.map((d) => d.revised_prompt));
          out.data.forEach((d, i) => expect("b64_json" in d).toBe("b64_json" in data[i]!));
          expect(out.data.every((d) => d.b64_json === undefined || d.b64_json === null)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});
