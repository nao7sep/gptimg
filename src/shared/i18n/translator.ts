// One translator per language: flat dotted keys, `{name}` placeholders, plural
// forms chosen by Intl.PluralRules as `key.one` / `key.other` (and the other
// CLDR categories), falling back to English and then to the key itself so the
// rendered-key gate can see a miss.
import type en from "./catalogues/en.json";
import type { Language } from "./languages.ts";

type Flat = Record<string, string>;
type PluralSuffix = "zero" | "one" | "two" | "few" | "many" | "other";
type BaseKey<K> = K extends `${infer B}.${PluralSuffix}` ? B : K;

/** Every key the English catalogue declares, plural families by their base. */
export type MessageKey = BaseKey<keyof typeof en & string>;
export type MessageValues = Record<string, string | number | Message>;

/** Text held as data, so it renders in whatever language is current when shown. */
export interface Message {
  key: MessageKey;
  values?: MessageValues;
}

export function message(key: MessageKey, values?: MessageValues): Message {
  return values ? { key, values } : { key };
}

export interface Translator {
  language: Language;
  locale: string;
  t(key: MessageKey, values?: MessageValues): string;
  of(msg: Message): string;
  has(key: string): boolean;
  number(value: number, options?: Intl.NumberFormatOptions): string;
  dateTime(iso: string, timeZone: string, options?: Intl.DateTimeFormatOptions): string;
}

export function createTranslator(language: Language, locale: string, catalogue: Flat, english: Flat): Translator {
  const plurals = new Intl.PluralRules(locale);
  const numbers = new Intl.NumberFormat(locale);

  const lookup = (key: string): string | undefined => catalogue[key] ?? english[key];

  const format = (template: string, values: MessageValues | undefined): string =>
    template.replace(/\{(\w+)\}/g, (whole, name: string) => {
      const value = values?.[name];
      if (value === undefined) return whole;
      if (typeof value === "number") return numbers.format(value);
      if (typeof value === "string") return value;
      return translator.of(value);
    });

  const translator: Translator = {
    language,
    locale,
    t(key, values) {
      const count = values?.count;
      if (typeof count === "number") {
        const form = lookup(`${key}.${plurals.select(count)}`) ?? lookup(`${key}.other`);
        if (form !== undefined) return format(form, values);
      }
      const template = lookup(key);
      return template === undefined ? key : format(template, values);
    },
    of(msg) {
      return translator.t(msg.key, msg.values);
    },
    has(key) {
      return lookup(key) !== undefined || lookup(`${key}.other`) !== undefined;
    },
    number(value, options) {
      return options ? new Intl.NumberFormat(locale, options).format(value) : numbers.format(value);
    },
    dateTime(iso, timeZone, options) {
      const zone = timeZone === "system" ? undefined : timeZone;
      return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", ...options, timeZone: zone }).format(new Date(iso));
    },
  };
  return translator;
}
