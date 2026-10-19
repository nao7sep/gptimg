// After every test that rendered into a document, no catalogue key may be on
// screen: a key in text or in a read attribute means a message was shown
// untranslated (localization-conventions, the rendered-key gate).
import { afterEach, expect } from "vitest";
import english from "../../src/shared/i18n/catalogues/en.json";

const PLURAL = /\.(zero|one|two|few|many|other)$/;
const KEYS = new Set(Object.keys(english).flatMap((key) => [key, key.replace(PLURAL, "")]));
const READ_ATTRIBUTES = ["aria-label", "title", "placeholder", "alt"];

/** The catalogue keys found in a document's text and read attributes. Exported so a test can plant one. */
export function renderedKeys(root: ParentNode): string[] {
  const found = new Set<string>();
  const check = (value: string | null) => {
    if (!value) return;
    for (const word of value.split(/\s+/)) if (KEYS.has(word.replace(/[.,:;!?)]+$/, ""))) found.add(word);
  };
  const walker = (root as Node).ownerDocument?.createTreeWalker(root as Node, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker?.nextNode(); node; node = walker?.nextNode()) check(node.textContent);
  for (const el of (root as Element).querySelectorAll?.("*") ?? []) for (const name of READ_ATTRIBUTES) check(el.getAttribute(name));
  return [...found];
}

afterEach(() => {
  if (typeof document === "undefined") return;
  expect(renderedKeys(document.body)).toEqual([]);
});
