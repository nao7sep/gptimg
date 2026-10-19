// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderedKeys } from "../setup/rendered-keys.ts";

describe("the rendered-key gate", () => {
  it("finds a planted key in text and in a read attribute", () => {
    const root = document.createElement("div");
    root.innerHTML = '<p>conversation.retry</p><button aria-label="composer.send">x</button><p>Try again</p>';
    expect(renderedKeys(root).sort()).toEqual(["composer.send", "conversation.retry"]);
  });
});
