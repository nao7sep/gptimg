import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { blocksOf, Markdown } from "../src/renderer/src/components/Markdown.tsx";

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe("formatted replies", () => {
  it("splits paragraphs, headings, lists, quotes and code", () => {
    expect(blocksOf("# Title\n\nOne\ntwo\n\n- a\n- b\n\n1. x\n2. y\n\n> said\n\n```\ncode\n```").map((b) => b.kind)).toEqual([
      "heading",
      "paragraph",
      "list",
      "list",
      "quote",
      "code",
    ]);
  });

  it("draws bold, italic, code and https links, and nothing else as markup", () => {
    expect(html("**bold** and *it* and `x` and [site](https://example.com)")).toBe(
      '<p><strong>bold</strong> and <em>it</em> and <code>x</code> and <a href="https://example.com" target="_blank" rel="noreferrer">site</a></p>',
    );
    expect(html("[plain](http://example.com) [script](javascript:void)")).toBe("<p>plain script</p>");
    expect(html("<img src=x onerror=alert(1)>")).toBe("<p>&lt;img src=x onerror=alert(1)&gt;</p>");
  });

  it("keeps an ordered list's start and a line break inside a paragraph", () => {
    expect(html("3. third\n4. fourth")).toBe('<ol start="3"><li>third</li><li>fourth</li></ol>');
    expect(html("one\ntwo")).toBe("<p>one<br/>two</p>");
  });
});
