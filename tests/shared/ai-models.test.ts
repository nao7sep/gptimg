// The app's own model table against the code that uses it (ai-model-routing-conventions):
// every role has rows, one default and a settings field, and every row agrees with the SDK's,
// which checks and sends the requests, so the composer and Settings never accept what the SDK
// would refuse. The table's own values come from the lineup research and are not restated here.
import { MODEL_LINEUP as SDK_LINEUP, SUPPORTED_MODELS as SDK_MODELS } from "gptimgsdk/types";
import { describe, expect, it } from "vitest";
import { AI_ROLES, MODEL_LINEUP, SUPPORTED_MODELS, defaultModelFor, findModelRow, modelSpelling, modelsFor } from "../../src/shared/ai-models.ts";
import { SET_KEYS, builtInSettings, normalizeSet } from "../../src/shared/settings.ts";

describe("the app's model table", () => {
  it("gives every role rows and exactly one default, which defaultModelFor returns", () => {
    for (const role of AI_ROLES) {
      const defaults = modelsFor("openai", role.kind).filter((row) => row.defaultFor.includes(role.kind));
      expect(defaults, role.id).toHaveLength(1);
      expect(defaultModelFor("openai", role.kind), role.id).toBe(defaults[0]!.id);
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
