import { describe, expect, it } from "vitest";
import { PANES, railWidth, windowMinimum } from "../../src/shared/layout.ts";
import { RAIL_WIDTH } from "../../src/shared/ui-state.ts";

describe("window minimum", () => {
  it("is the sum of the panes' minimums", () => {
    expect(windowMinimum()).toEqual({
      width: PANES.rail.minWidth + PANES.splitter.width + PANES.conversation.minWidth,
      height: PANES.header.height + PANES.transcript.minHeight + PANES.composer.minHeight,
    });
  });

  it("clamps the rail to leave the conversation its minimum, without changing the intent", () => {
    const min = windowMinimum().width;
    expect(railWidth(400, min)).toBe(RAIL_WIDTH.min);
    expect(railWidth(400, 2000)).toBe(400);
    expect(railWidth(null, 2000)).toBe(RAIL_WIDTH.initial);
  });
  it("leaves room for the visible image pane at a wide rail", () => {
    expect(railWidth(400, 970, true) + PANES.splitter.width + PANES.conversation.minWidth + PANES.images.width).toBe(970);
    expect(railWidth(400, 960, true)).toBe(400);
  });

});
