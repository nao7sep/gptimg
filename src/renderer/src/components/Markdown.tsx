// The assistant's replies as formatted text. The model writes Markdown; this
// draws the part a chat reply uses (paragraphs, headings, lists, quotes,
// code, bold, italic, links) as React elements, so no reply can inject
// markup. A link opens in the browser, and only an https one is a link.
import type { ReactNode } from "react";

type Block =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string };

const LIST_ITEM = /^\s{0,3}(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/;

/** Splits a reply into blocks. Exported for tests. */
export function blocksOf(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) code.push(lines[i]!);
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]! });
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      flush();
      const quote: string[] = [];
      for (; i < lines.length && /^\s{0,3}>/.test(lines[i]!); i++) quote.push(lines[i]!.replace(/^\s{0,3}>\s?/, ""));
      i--;
      blocks.push({ kind: "quote", text: quote.join("\n") });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      flush();
      const ordered = item[2] !== undefined;
      const start = ordered ? Number(item[2]) : 1;
      const items: string[] = [];
      for (; i < lines.length; i++) {
        const next = LIST_ITEM.exec(lines[i]!);
        if (next && (next[2] !== undefined) === ordered) items.push(next[3]!);
        else if (lines[i]!.trim() !== "" && /^\s{2,}/.test(lines[i]!) && items.length > 0) items[items.length - 1] += `\n${lines[i]!.trim()}`;
        else break;
      }
      i--;
      blocks.push({ kind: "list", ordered, start, items });
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\n]+\*|_[^_\n]+_)|(\[[^\]\n]+\]\([^)\s]+\))/g;

/** Inline formatting as elements; text between stays text. Exported for tests. */
export function inline(text: string, key = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const token = match[0];
    const k = `${key}-${n++}`;
    if (match[1]) out.push(<code key={k}>{token.slice(1, -1)}</code>);
    else if (match[2]) out.push(<strong key={k}>{inline(token.slice(2, -2), k)}</strong>);
    else if (match[3]) out.push(<em key={k}>{inline(token.slice(1, -1), k)}</em>);
    else {
      const [, label, href] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)!;
      out.push(
        href!.startsWith("https://") ? (
          <a key={k} href={href} target="_blank" rel="noreferrer">
            {label}
          </a>
        ) : (
          label
        ),
      );
    }
    last = at + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function withBreaks(text: string, key: string): ReactNode[] {
  return text.split("\n").flatMap((line, i) => (i === 0 ? inline(line, `${key}-${i}`) : [<br key={`${key}-br-${i}`} />, ...inline(line, `${key}-${i}`)]));
}

export function Markdown({ text }: { text: string }) {
  return (
    <>
      {blocksOf(text).map((block, i) => {
        const key = `b${i}`;
        switch (block.kind) {
          case "heading":
            return (
              <p key={key} className={`md-heading md-h${Math.min(block.level, 3)}`}>
                {inline(block.text, key)}
              </p>
            );
          case "list": {
            const items = block.items.map((item, j) => <li key={`${key}-${j}`}>{withBreaks(item, `${key}-${j}`)}</li>);
            return block.ordered ? (
              <ol key={key} start={block.start}>
                {items}
              </ol>
            ) : (
              <ul key={key}>{items}</ul>
            );
          }
          case "quote":
            return <blockquote key={key}>{withBreaks(block.text, key)}</blockquote>;
          case "code":
            return (
              <pre key={key}>
                <code>{block.text}</code>
              </pre>
            );
          default:
            return <p key={key}>{withBreaks(block.text, key)}</p>;
        }
      })}
    </>
  );
}
