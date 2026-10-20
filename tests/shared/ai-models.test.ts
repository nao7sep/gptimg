// The app's own model table (ai-model-routing-conventions): pinned here, and
// held equal to the SDK's rows for the values both check, so the composer and
// Settings never accept what the SDK would refuse.
import { MODEL_LINEUP as SDK_LINEUP, SUPPORTED_MODELS as SDK_MODELS } from "gptimgsdk/types";
import { describe, expect, it } from "vitest";
import { AI_ROLES, MODEL_LINEUP, SUPPORTED_MODELS, defaultModelFor, findModelRow, modelSpelling, modelsFor } from "../../src/shared/ai-models.ts";
import { SET_KEYS, builtInSettings, normalizeSet } from "../../src/shared/settings.ts";

describe("the app's model table", () => {
  it("pins the lineup, the row order and the defaults", () => {
    expect(MODEL_LINEUP).toBe("ai-model-lineup-20261004");
    expect(SUPPORTED_MODELS.map((row) => row.id)).toEqual([
      "gpt-image-2.5-flare",
      "gpt-image-2.5-sunburst",
      "gpt-image-2",
      "gpt-6-astra",
      "gpt-6.1-sol",
      "gpt-5.6-terra",
      "gpt-6-luna",
    ]);
    expect(defaultModelFor("openai", "chat")).toBe("gpt-5.6-terra");
    expect(defaultModelFor("openai", "image-edit")).toBe("gpt-image-2.5-sunburst");
    for (const kind of ["chat", "image-edit"] as const) {
      expect(modelsFor("openai", kind).filter((row) => row.defaultFor.includes(kind))).toHaveLength(1);
    }
  });

  it("gives every role a settings field, holding its default", () => {
    const built = builtInSettings();
    for (const role of AI_ROLES) {
      expect(SET_KEYS).toContain(role.setting);
      expect(built[role.setting]).toBe(defaultModelFor("openai", role.kind));
    }
  });

  it("matches ids without regard to case and keeps the row's spelling", () => {
    expect(findModelRow("  GPT-6-Luna ")?.id).toBe("gpt-6-luna");
    expect(modelSpelling("GPT-Image-2")).toBe("gpt-image-2");
    expect(modelSpelling(" my-proxy-Model ")).toBe("my-proxy-Model");
    expect(normalizeSet("openai.chat", "GPT-5.6-Terra")).toBe("gpt-5.6-terra");
  });

  it("agrees with the SDK's rows on every value both check", () => {
    expect(MODEL_LINEUP).toBe(SDK_LINEUP);
    for (const row of SUPPORTED_MODELS) {
      const sdk = SDK_MODELS.find((candidate) => candidate.id === row.id);
      expect(sdk, row.id).toBeDefined();
      if ("image" in row) {
        expect("image" in sdk! && sdk.image.qualities, row.id).toEqual(row.image.qualities);
        expect("image" in sdk! && sdk.image.size, row.id).toEqual(row.image.size);
      } else {
        expect("thinking" in sdk! && [sdk.thinking, sdk.defaultThinking, sdk.kinds.includes("chat")], row.id).toEqual([row.thinking, row.defaultThinking, true]);
      }
    }
  });
});
