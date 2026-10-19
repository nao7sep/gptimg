// The UI and conversation fonts from Settings, applied as the tokens' variables.
import type { Settings } from "../../shared/settings.ts";

export function applyFonts(settings: Settings): void {
  const style = document.documentElement.style;
  style.setProperty("--font-ui", settings.uiFont);
  style.setProperty("--font-content", settings.contentFont.family);
  style.setProperty("--content-reading", `${settings.contentFont.readingSize}px`);
  style.setProperty("--content-writing", `${settings.contentFont.writingSize}px`);
  style.setProperty("--content-line", String(settings.contentFont.lineHeight));
}
