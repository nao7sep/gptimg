import { describe, expect, it } from "vitest";
import { responseIdOf, usageOf } from "../src/usage.ts";

describe("usage and response id", () => {
  it("keeps a chat turn's image tool tokens apart from the assistant's", () => {
    const response = {
      id: "resp_1",
      usage: { input_tokens: 1766, output_tokens: 105 },
      tool_usage: { image_gen: { input_tokens: 78, output_tokens: 196 }, web_search: { num_requests: 0 } },
    };
    expect(usageOf(response)).toEqual({ input: 1766, output: 105, imageInput: 78, imageOutput: 196 });
    expect(responseIdOf(response)).toBe("resp_1");
  });

  it("reads the images endpoint's and chat completions' usage, and nothing from a response without one", () => {
    expect(usageOf({ usage: { input_tokens: 5, output_tokens: 6 } })).toEqual({ input: 5, output: 6 });
    expect(usageOf({ id: "chatcmpl-1", usage: { prompt_tokens: 7, completion_tokens: 8 } })).toEqual({ input: 7, output: 8 });
    expect(usageOf({})).toBeNull();
    expect(responseIdOf({ created: 1, data: [] })).toBeNull();
  });
});
