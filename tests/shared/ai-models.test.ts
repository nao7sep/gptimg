// The app's model choices over the SDK's table (ai-model-routing-conventions): each offered
// role's setting starts at the SDK's default, and ids typed in Settings match the SDK's rows
// without regard to case and are stored in the row's spelling.
import { defaultModelFor } from "gptimgsdk/types";
import { describe, expect, it } from "vitest";
import { builtInSettings, CHAT_KIND, chatRow, IMAGE_KIND, imageRow, modelSpelling, normalizeSet } from "../../src/shared/settings.ts";

describe("the app's model choices", () => {
  it("suggests the SDK's default for the conversation and for the image tool", () => {
    const built = builtInSettings();
    expect(built["openai.chat"]).toBe(defaultModelFor("openai", CHAT_KIND));
    expect(built["openai.image"]).toBe(defaultModelFor("openai", IMAGE_KIND));
    expect(chatRow(built["openai.chat"])).toBeDefined();
    expect(imageRow(built["openai.image"])).toBeDefined();
  });

  it("matches ids without regard to case and keeps the row's spelling", () => {
    expect(chatRow("  GPT-6-Luna ")?.id).toBe("gpt-6-luna");
    expect(modelSpelling("GPT-Image-2")).toBe("gpt-image-2");
    expect(modelSpelling(" my-proxy-Model ")).toBe("my-proxy-Model");
    expect(normalizeSet("openai.chat", "GPT-5.6-Terra")).toBe("gpt-5.6-terra");
  });
});
