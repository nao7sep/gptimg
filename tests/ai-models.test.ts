// Guard test for the model table and the request branches (ai-model-routing-conventions):
// the lineup's rows, their order, lists and defaults are pinned; every row has its branch and
// every branch its row; each role has exactly one default; and an id with no row gets the plain
// request untouched.

import { describe, expect, it } from "vitest";

import {
  AI_ROLES,
  MODEL_LINEUP,
  SUPPORTED_MODELS,
  defaultModelFor,
  modelsFor,
  type AiKind,
  type ImageModelRow,
  type VisionModelRow,
} from "../src/ai-models.js";
import {
  IMAGE_REQUEST_BRANCHES,
  VISION_REQUEST_BRANCHES,
  buildImageRequest,
  buildVisionRequest,
} from "../src/providers/openai/request.js";

const IMAGE_KINDS: readonly AiKind[] = ["image-generate", "image-edit"];
const REMOVED_VISION_IDS = ["gpt-5.6-sol", "gpt-5.6-luna"] as const;

const imageRows = SUPPORTED_MODELS.filter((row): row is ImageModelRow => "image" in row);
const visionRows = SUPPORTED_MODELS.filter((row): row is VisionModelRow => "thinking" in row);

describe("the model table", () => {
  it("rests on the 2026-10-04 lineup", () => {
    expect(MODEL_LINEUP).toBe("ai-model-lineup-20261004");
  });

  it("lists the lineup's rows in order, highest tier first", () => {
    expect(SUPPORTED_MODELS.map((row) => [row.id, row.kinds, row.defaultFor])).toEqual([
      ["gpt-image-2.5-flare", ["image-generate", "image-edit"], ["image-generate"]],
      ["gpt-image-2.5-sunburst", ["image-generate", "image-edit"], ["image-edit"]],
      ["gpt-image-2", ["image-generate", "image-edit"], []],
      ["gpt-6-astra", ["vision"], []],
      ["gpt-6.1-sol", ["vision"], []],
      ["gpt-5.6-terra", ["vision"], []],
      ["gpt-6-luna", ["vision"], ["vision"]],
    ]);
    for (const row of SUPPORTED_MODELS) expect(row.provider, row.id).toBe("openai");
  });

  it("pins each image row's values and size rule", () => {
    const shared = {
      backgrounds: ["auto", "transparent", "opaque"],
      outputFormats: ["png", "jpeg", "webp"],
      compression: { min: 0, max: 100, formats: ["jpeg", "webp"] },
      size: { multipleOf: 16, maxRatio: 3, minPixels: 655_360, maxPixels: 8_294_400 },
    };
    expect(Object.fromEntries(imageRows.map((row) => [row.id, row.image]))).toEqual({
      "gpt-image-2.5-flare": { qualities: ["auto", "low", "medium", "high", "xhigh", "max"], ...shared },
      "gpt-image-2.5-sunburst": { qualities: ["auto", "low", "medium", "high", "xhigh", "max"], ...shared },
      "gpt-image-2": { qualities: ["auto", "low", "medium", "high"], ...shared },
    });
  });

  it("pins each vision row's effort list and its tier's default", () => {
    expect(Object.fromEntries(visionRows.map((row) => [row.id, [row.thinking, row.defaultThinking]]))).toEqual({
      "gpt-6-astra": [["low", "medium", "high", "xhigh", "max"], "medium"],
      "gpt-6.1-sol": [["low", "medium", "high", "xhigh", "max"], "medium"],
      "gpt-5.6-terra": [["none", "low", "medium", "high", "xhigh", "max"], "medium"],
      "gpt-6-luna": [["none", "low", "medium", "high", "xhigh", "max"], "none"],
    });
    for (const row of visionRows) expect(row.thinking, row.id).toContain(row.defaultThinking);
  });

  it("no longer lists the removed vision models", () => {
    for (const id of REMOVED_VISION_IDS) {
      expect(SUPPORTED_MODELS.some((row) => row.id === id), id).toBe(false);
      expect(VISION_REQUEST_BRANCHES[id], id).toBeUndefined();
    }
  });

  it("gives every image row an image branch and every vision row a vision branch", () => {
    for (const row of SUPPORTED_MODELS) {
      if (row.kinds.some((kind) => IMAGE_KINDS.includes(kind))) {
        expect(IMAGE_REQUEST_BRANCHES[row.id], `${row.id} image branch`).toBeTypeOf("function");
      }
      if (row.kinds.includes("vision")) {
        expect(VISION_REQUEST_BRANCHES[row.id], `${row.id} vision branch`).toBeTypeOf("function");
      }
    }
  });

  it("has a row for every branch", () => {
    expect(Object.keys(IMAGE_REQUEST_BRANCHES).sort()).toEqual(imageRows.map((row) => row.id).sort());
    expect(Object.keys(VISION_REQUEST_BRANCHES).sort()).toEqual(visionRows.map((row) => row.id).sort());
  });

  it("gives image rows image kinds and vision rows the vision kind", () => {
    for (const row of imageRows) expect(row.kinds, row.id).toEqual(["image-generate", "image-edit"]);
    for (const row of visionRows) expect(row.kinds, row.id).toEqual(["vision"]);
  });

  it("lists each id once", () => {
    const ids = SUPPORTED_MODELS.map((row) => `${row.provider}:${row.id}`);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every role rows and exactly one default", () => {
    for (const role of AI_ROLES) {
      const rows = modelsFor("openai", role.kind);
      expect(rows.length, role.id).toBeGreaterThan(0);
      expect(rows.filter((row) => row.defaultFor.includes(role.kind)), role.id).toHaveLength(1);
    }
  });

  it("only marks a row default for a kind it serves", () => {
    for (const row of SUPPORTED_MODELS) {
      for (const kind of row.defaultFor) expect(row.kinds, row.id).toContain(kind);
    }
  });

  it("defaults generate to flare, edit to sunburst and vision to the fast-tier Luna", () => {
    expect(defaultModelFor("openai", "image-generate")).toBe("gpt-image-2.5-flare");
    expect(defaultModelFor("openai", "image-edit")).toBe("gpt-image-2.5-sunburst");
    expect(defaultModelFor("openai", "vision")).toBe("gpt-6-luna");
  });
});

describe("the request builder", () => {
  it("sends an id with no row as the plain request, unchanged", () => {
    const request = { model: "some-future-image-model", prompt: "p", quality: "low" };
    expect(buildImageRequest("some-future-image-model", { ...request })).toEqual(request);
    const vision = { model: "some-future-chat-model", messages: [] };
    expect(buildVisionRequest("some-future-chat-model", { ...vision }, undefined)).toEqual(vision);
  });

  it("sends an unlisted or removed vision id the plain request, plus only the caller's own effort", () => {
    for (const id of ["some-future-chat-model", ...REMOVED_VISION_IDS]) {
      const vision = { model: id, messages: [], response_format: { type: "json_schema" } };
      expect(buildVisionRequest(id, { ...vision }, undefined), id).toEqual(vision);
      expect(buildVisionRequest(id, { ...vision }, "low"), id).toEqual({ ...vision, reasoning_effort: "low" });
    }
  });

  it("sends every image row's every value as chosen, auto included", () => {
    for (const row of imageRows) {
      for (const quality of row.image.qualities) {
        for (const background of row.image.backgrounds) {
          const request = { model: row.id, prompt: "p", quality, background, moderation: "low", size: "auto" };
          expect(buildImageRequest(row.id, { ...request }), `${row.id} ${quality} ${background}`).toEqual(request);
        }
      }
      for (const output_format of row.image.outputFormats) {
        const request = { model: row.id, prompt: "p", output_format, output_compression: 100 };
        expect(buildImageRequest(row.id, { ...request }), `${row.id} ${output_format}`).toEqual(request);
      }
    }
  });

  it("sends every vision row's every effort as reasoning_effort, and changes nothing else", () => {
    for (const row of visionRows) {
      for (const reasoning of row.thinking) {
        const request = { model: row.id, messages: [], response_format: { type: "json_schema" } };
        expect(buildVisionRequest(row.id, { ...request }, reasoning), `${row.id} ${reasoning}`).toEqual({
          ...request,
          reasoning_effort: reasoning,
        });
      }
    }
  });
});
