// The page's background colour, light and dark: what a window shows before its
// page paints, so it opens in the page's own colour instead of flashing white or
// black. tokens.css's --bg holds the same two values, and a test checks them.
export const PAGE_BACKGROUND = { light: "#f6f3ee", dark: "#141517" } as const;
