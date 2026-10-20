import { nativeTheme } from "electron";
import { PAGE_BACKGROUND } from "../shared/page-background.ts";

/** The page background of the theme the window opens in. */
export function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? PAGE_BACKGROUND.dark : PAGE_BACKGROUND.light;
}
