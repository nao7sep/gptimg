// Guard test for the model table and the request branches (ai-model-routing-conventions):
// every row has its branch, every branch has its row, each role has exactly one default,
// and an id with no row gets the plain request untouched.

import { describe, expect, it } from "vitest";

import { AI_ROLES, SUPPORTED_MODELS, defaultModelFor, modelsFor, type AiKind } from "../src/ai-models.js";
import {
  IMAGE_REQUEST_BRANCHES,
  VISION_REQUEST_BRANCHES,
  buildImageRequest,
  buildVisionRequest,
} from "../src/providers/openai/request.js";

const IMAGE_KINDS: readonly AiKind[] = ["image-generate", "image-edit"];

describe("the model table", () => {
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
    const imageRows = SUPPORTED_MODELS.filter((row) => row.kinds.some((kind) => IMAGE_KINDS.includes(kind))).map((row) => row.id);
    const visionRows = SUPPORTED_MODELS.filter((row) => row.kinds.includes("vision")).map((row) => row.id);
    expect(Object.keys(IMAGE_REQUEST_BRANCHES).sort()).toEqual([...imageRows].sort());
    expect(Object.keys(VISION_REQUEST_BRANCHES).sort()).toEqual([...visionRows].sort());
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
    expect(buildVisionRequest("some-future-chat-model", { ...vision })).toEqual(vision);
  });

  it("adds nothing for a supported id, whose branches say they need nothing", () => {
    for (const id of Object.keys(IMAGE_REQUEST_BRANCHES)) {
      const request = { model: id, prompt: "p" };
      expect(buildImageRequest(id, { ...request }), id).toEqual(request);
    }
    for (const id of Object.keys(VISION_REQUEST_BRANCHES)) {
      const request = { model: id, messages: [] };
      expect(buildVisionRequest(id, { ...request }), id).toEqual(request);
    }
  });
});
