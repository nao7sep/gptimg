// The user's settings, by set (config-sets-conventions): each set has a stable
// key and a built-in in code; config.json holds a set only while the user's
// copy differs from its built-in. Everything here is pure, so main validates
// what it loads and the renderer validates a draft with the same rules.
import { defaultModelFor, findModelRow, modelSpelling, type ChatModelRow, type ImageModelRow } from "./ai-models.ts";
import { LANGUAGE_PREFERENCES, type LanguagePreference } from "./i18n/languages.ts";

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export const SYSTEM_UI_FONT = 'system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** The conversation's text: one family for reading and writing, each with its own size. */
export interface ContentFont {
  family: string;
  readingSize: number;
  writingSize: number;
  lineHeight: number;
}

export const CONTENT_SIZE = { min: 11, max: 24 } as const;
export const CONTENT_LINE_HEIGHT = { min: 1.2, max: 2 } as const;

export interface Settings {
  language: LanguagePreference;
  theme: Theme;
  /** "system" or an IANA zone; times are shown in it. */
  timeZone: string;
  uiFont: string;
  contentFont: ContentFont;
  /** Absolute path of the folder holding session folders; "" until first run chooses it. */
  sessionsDir: string;
  "openai.endpoint": string;
  "openai.chat": string;
  "openai.thinking.chat": string;
  "openai.image": string;
  /** How many drafts of each image to show while it is drawn, 0 to 3; each costs a little more. */
  "openai.drafts": number;
}

export const DRAFT_COUNTS = [0, 1, 2, 3] as const;

export const OPENAI_ENDPOINT = "https://api.openai.com/v1";

/** An endpoint the app can send to: an http(s) URL with a host. */
export function isEndpoint(value: string): boolean {
  return /^https?:\/\/[^\s/]+/.test(value.trim());
}

export type SetKey = keyof Settings;

export const CHAT_KIND = "chat";
export const IMAGE_KIND = "image-edit";

export function builtInSettings(): Settings {
  const chat = defaultModelFor("openai", CHAT_KIND);
  return {
    language: "system",
    theme: "system",
    timeZone: "system",
    uiFont: SYSTEM_UI_FONT,
    contentFont: { family: SYSTEM_UI_FONT, readingSize: 15, writingSize: 14, lineHeight: 1.55 },
    sessionsDir: "",
    "openai.endpoint": OPENAI_ENDPOINT,
    "openai.chat": chat,
    "openai.thinking.chat": defaultThinkingFor(chat) ?? "",
    "openai.image": defaultModelFor("openai", IMAGE_KIND),
    "openai.drafts": 2,
  };
}

export const SET_KEYS = Object.keys(builtInSettings()) as SetKey[];

/** The supported assistant row for an id, compared trimmed and case-insensitive; undefined for an id with no row. */
export function chatRow(id: string): ChatModelRow | undefined {
  const row = findModelRow(id);
  return row && "thinking" in row && row.kinds.includes(CHAT_KIND) ? row : undefined;
}

export function imageRow(id: string): ImageModelRow | undefined {
  const row = findModelRow(id);
  return row && "image" in row ? row : undefined;
}

export function defaultThinkingFor(model: string): string | undefined {
  return chatRow(model)?.defaultThinking;
}

/** Single-line cleanup (text-cleanup-conventions): trim, and collapse no inner spacing. */
export function cleanLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function isZone(value: string): boolean {
  if (value === "system") return true;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Why a value cannot be a set's value, as a catalogue key; null when it can. */
export function validateSet<K extends SetKey>(key: K, value: unknown): string | null {
  switch (key) {
    case "language":
      return typeof value === "string" && (LANGUAGE_PREFERENCES as readonly string[]).includes(value) ? null : "settings.error.choice";
    case "theme":
      return typeof value === "string" && (THEMES as readonly string[]).includes(value) ? null : "settings.error.choice";
    case "timeZone":
      return typeof value === "string" && isZone(value) ? null : "settings.error.timeZone";
    case "uiFont":
      return typeof value === "string" && cleanLine(value) !== "" ? null : "settings.error.required";
    case "contentFont": {
      if (!value || typeof value !== "object") return "settings.error.shape";
      const font = value as Record<string, unknown>;
      if (typeof font.family !== "string" || cleanLine(font.family) === "") return "settings.error.required";
      for (const size of [font.readingSize, font.writingSize]) {
        if (typeof size !== "number" || !Number.isInteger(size) || size < CONTENT_SIZE.min || size > CONTENT_SIZE.max) {
          return "settings.error.fontSize";
        }
      }
      const lh = font.lineHeight;
      if (typeof lh !== "number" || !Number.isFinite(lh) || lh < CONTENT_LINE_HEIGHT.min || lh > CONTENT_LINE_HEIGHT.max) {
        return "settings.error.lineHeight";
      }
      return null;
    }
    case "sessionsDir":
      return typeof value === "string" ? null : "settings.error.shape";
    case "openai.endpoint":
      return typeof value === "string" && isEndpoint(value) ? null : "settings.error.endpoint";
    case "openai.chat":
    case "openai.image":
      return typeof value === "string" && cleanLine(value) !== "" ? null : "settings.error.required";
    case "openai.thinking.chat":
      return typeof value === "string" ? null : "settings.error.shape";
    case "openai.drafts":
      return (DRAFT_COUNTS as readonly unknown[]).includes(value) ? null : "settings.error.shape";
    default:
      return "settings.error.shape";
  }
}

/** A set's value as it is compared and stored: text cleaned, a listed model id in its row's spelling. */
export function normalizeSet<K extends SetKey>(key: K, value: Settings[K]): Settings[K] {
  if ((key === "openai.chat" || key === "openai.image") && typeof value === "string") return modelSpelling(cleanLine(value)) as Settings[K];
  if (key === "contentFont") {
    const font = value as ContentFont;
    return { ...font, family: cleanLine(font.family) } as Settings[K];
  }
  if (typeof value === "string") return cleanLine(value) as Settings[K];
  return value;
}

export function setsEqual<K extends SetKey>(key: K, a: Settings[K], b: Settings[K]): boolean {
  if (key === "openai.endpoint") return String(a).trim().replace(/\/+$/, "") === String(b).trim().replace(/\/+$/, "");
  if (key === "openai.chat" || key === "openai.image") {
    return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  }
  return JSON.stringify(normalizeSet(key, a)) === JSON.stringify(normalizeSet(key, b));
}

/**
 * The thinking choice a model field lands on (ai-model-routing-conventions):
 * it resets to the row's default only when the model reaches a different
 * listed row than the last one it held.
 */
export function thinkingAfterModelChange(lastRow: string | null, nextModel: string, current: string): { thinking: string; lastRow: string | null } {
  const row = chatRow(nextModel);
  if (!row) return { thinking: current, lastRow };
  if (lastRow === row.id) return { thinking: current, lastRow };
  if (lastRow === null && row.thinking.includes(current)) return { thinking: current, lastRow: row.id };
  return { thinking: row.defaultThinking, lastRow: row.id };
}

/** The thinking value actually stored for a model: its default is not stored, so it follows the row. */
export function effectiveThinking(settings: Settings): string | undefined {
  const row = chatRow(settings["openai.chat"]);
  if (!row) return undefined;
  const chosen = settings["openai.thinking.chat"];
  return row.thinking.includes(chosen) ? chosen : row.defaultThinking;
}

/** The sets that differ from their built-ins, each whole: what config.json holds. */
export function differingSets(settings: Settings): Partial<Settings> {
  const builtIn = builtInSettings();
  const out: Partial<Record<SetKey, unknown>> = {};
  for (const key of SET_KEYS) {
    if (key === "openai.thinking.chat") {
      const row = chatRow(settings["openai.chat"]);
      if (row && settings[key] === row.defaultThinking) continue;
      if (!row && settings[key] === builtIn[key]) continue;
      out[key] = settings[key];
      continue;
    }
    if (!setsEqual(key, settings[key], builtIn[key])) out[key] = normalizeSet(key, settings[key]);
  }
  return out as Partial<Settings>;
}

export interface LoadedSettings {
  settings: Settings;
  /** Set keys whose stored value was invalid and fell back to the built-in, kept on disk until a save. */
  invalid: SetKey[];
  /** Keys in the file this version does not know, preserved on save. */
  unknown: Record<string, unknown>;
}

/** Reads config.json's set map: absent keys are built-ins; an invalid set falls back without touching the file. */
export function readSets(stored: Record<string, unknown>): LoadedSettings {
  const settings = builtInSettings();
  const invalid: SetKey[] = [];
  const unknown: Record<string, unknown> = {};
  for (const key of Object.keys(stored)) {
    const value = stored[key];
    if (!(SET_KEYS as string[]).includes(key)) {
      unknown[key] = value;
      continue;
    }
    const setKey = key as SetKey;
    if (validateSet(setKey, value) === null) {
      (settings as unknown as Record<string, unknown>)[setKey] = value;
    } else {
      invalid.push(setKey);
    }
  }
  if (!Object.hasOwn(stored, "openai.thinking.chat")) {
    settings["openai.thinking.chat"] = defaultThinkingFor(settings["openai.chat"]) ?? "";
  }
  return { settings, invalid, unknown };
}
