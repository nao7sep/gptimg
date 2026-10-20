// Guard test for the model table against the code that uses it (ai-model-routing-conventions):
// every row has its branch and every branch its row, each effort a row lists is one its branch
// sends, each role has rows and exactly one default, and an id with no row gets the plain request
// untouched. The table's own values come from the lineup research and are not restated here.

import { describe, expect, it } from "vitest";

import {
  AI_ROLES,
  SUPPORTED_MODELS,
  defaultModelFor,
  modelsFor,
  type AiKind,
  type ImageModelRow,
  type VisionModelRow,
} from "../src/ai-models.ts";
import {
  CHAT_REQUEST_BRANCHES,
  IMAGE_REQUEST_BRANCHES,
  VISION_REQUEST_BRANCHES,
  buildChatRequest,
  buildImageRequest,
  buildVisionRequest,
} from "../src/providers/openai/request.ts";

const IMAGE_KINDS: readonly AiKind[] = ["image-generate", "image-edit"];

const imageRows = SUPPORTED_MODELS.filter((row): row is ImageModelRow => "image" in row);
const visionRows = SUPPORTED_MODELS.filter((row): row is VisionModelRow => "thinking" in row);

describe("the model table", () => {
  it("lists each vision row's own default effort among the efforts it takes", () => {
    for (const row of visionRows) expect(row.thinking, row.id).toContain(row.defaultThinking);
  });

  it("gives every image row an image branch and every vision row a vision branch", () => {
    for (const row of SUPPORTED_MODELS) {
      if (row.kinds.some((kind) => IMAGE_KINDS.includes(kind))) {
        expect(IMAGE_REQUEST_BRANCHES[row.id], `${row.id} image branch`).toBeTypeOf("function");
      }
      if (row.kinds.includes("vision")) {
        expect(VISION_REQUEST_BRANCHES[row.id], `${row.id} vision branch`).toBeTypeOf("function");
      }
      if (row.kinds.includes("chat")) {
        expect(CHAT_REQUEST_BRANCHES[row.id], `${row.id} chat branch`).toBeTypeOf("function");
      }
    }
  });

  it("has a row for every branch", () => {
    expect(Object.keys(IMAGE_REQUEST_BRANCHES).sort()).toEqual(imageRows.map((row) => row.id).sort());
    expect(Object.keys(VISION_REQUEST_BRANCHES).sort()).toEqual(visionRows.map((row) => row.id).sort());
    expect(Object.keys(CHAT_REQUEST_BRANCHES).sort()).toEqual(SUPPORTED_MODELS.filter((row) => row.kinds.includes("chat")).map((row) => row.id).sort());
  });

  it("lists each id once", () => {
    const ids = SUPPORTED_MODELS.map((row) => `${row.provider}:${row.id}`);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every role rows and exactly one default", () => {
    for (const role of AI_ROLES) {
      const rows = modelsFor("openai", role.kind);
      expect(rows.length, role.id).toBeGreaterThan(0);
      const defaults = rows.filter((row) => row.defaultFor.includes(role.kind));
      expect(defaults, role.id).toHaveLength(1);
      expect(defaultModelFor("openai", role.kind), role.id).toBe(defaults[0]!.id);
    }
  });

  it("only marks a row default for a kind it serves", () => {
    for (const row of SUPPORTED_MODELS) {
      for (const kind of row.defaultFor) expect(row.kinds, row.id).toContain(kind);
    }
  });

});

describe("the request builder", () => {
  it.each(Object.getOwnPropertyNames(Object.prototype))(
    "sends the unlisted prototype name %s as the plain image request",
    (id) => {
      const request = { model: id, prompt: "p", quality: "low", output_format: "png" };
      expect(buildImageRequest(id, request)).toEqual(request);
    },
  );

  it.each(Object.getOwnPropertyNames(Object.prototype))(
    "sends the unlisted prototype name %s as plain vision, preserving explicit effort",
    (id) => {
      const request = { model: id, messages: [], response_format: { type: "json_schema" } };
      expect(buildVisionRequest(id, request, undefined)).toEqual(request);
      expect(buildVisionRequest(id, request, "low")).toEqual({ ...request, reasoning_effort: "low" });
    },
  );

  it("sends an id with no row as the plain request, unchanged", () => {
    const request = { model: "some-future-image-model", prompt: "p", quality: "low" };
    expect(buildImageRequest("some-future-image-model", { ...request })).toEqual(request);
    const vision = { model: "some-future-chat-model", messages: [] };
    expect(buildVisionRequest("some-future-chat-model", { ...vision }, undefined)).toEqual(vision);
  });

  it("sends an unlisted vision id the plain request, plus only the caller's own effort", () => {
    for (const id of ["some-future-chat-model", "gpt-5.6-sol"]) {
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

  it("sends every chat row's every effort as reasoning.effort, and changes nothing else", () => {
    for (const row of visionRows.filter((candidate) => candidate.kinds.includes("chat"))) {
      for (const reasoning of row.thinking) {
        const request = { model: row.id, input: [] };
        expect(buildChatRequest(row.id, { ...request }, reasoning), `${row.id} ${reasoning}`).toEqual({ ...request, reasoning: { effort: reasoning } });
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
