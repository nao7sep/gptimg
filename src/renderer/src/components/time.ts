// Times as the reader sees them, in the display zone from Settings.
import type { Translator } from "../../../shared/i18n/translator.ts";

function dayKey(date: Date, zone: string | undefined): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** Today's times as a time, earlier days as a date. */
export function relativeDay(iso: string, timeZone: string, translator: Translator, now = new Date()): string {
  const zone = timeZone === "system" ? undefined : timeZone;
  const date = new Date(iso);
  if (dayKey(date, zone) === dayKey(now, zone)) {
    return translator.dateTime(iso, timeZone, { dateStyle: undefined, timeStyle: "short" });
  }
  return translator.dateTime(iso, timeZone, { dateStyle: "medium", timeStyle: undefined });
}

/** m:ss for the working counter. */
export function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
