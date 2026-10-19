// The main window's pane minimums, and the window minimum derived from them
// (window-conventions): the renderer lays panes out with these numbers and
// main hands their sum to the OS, so the two cannot disagree.
import { RAIL_WIDTH } from "./ui-state.ts";

export const PANES = {
  rail: { minWidth: RAIL_WIDTH.min },
  splitter: { width: 6 },
  /** The conversation column: narrow enough for a laptop split, wide enough for a print and its actions. */
  conversation: { minWidth: 440 },
  header: { height: 48 },
  /** The transcript keeps room for at least one print's actions and a line of text. */
  transcript: { minHeight: 180 },
  /** The composer at one row with its chips row and its controls row. */
  composer: { minHeight: 132 },
} as const;

export function windowMinimum(): { width: number; height: number } {
  return {
    width: PANES.rail.minWidth + PANES.splitter.width + PANES.conversation.minWidth,
    height: PANES.header.height + PANES.transcript.minHeight + PANES.composer.minHeight,
  };
}

export const INITIAL_WINDOW = { width: 1180, height: 820 } as const;

/** The rail's displayed width: the user's drag intent clamped so the conversation keeps its minimum. */
export function railWidth(intent: number | null, windowWidth: number): number {
  const wanted = intent ?? RAIL_WIDTH.initial;
  const fit = windowWidth - PANES.splitter.width - PANES.conversation.minWidth;
  return Math.max(RAIL_WIDTH.min, Math.min(wanted, RAIL_WIDTH.max, fit));
}
