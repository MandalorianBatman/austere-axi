// The small markdown an agent's reply may use: paragraphs, lists, fenced code, headings (as bold), and inline
// `code`, **bold**, *italic* and [links](https://…). Drawn as elements, never as HTML: the text is not trusted.
import { Fragment } from "react";
import type { ReactElement, ReactNode } from "react";

const LIST = /^\s*([-*]|\d+\.)\s+/;

/** Inline spans: code first (its text is left alone), then bold, italic and links in what is between. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  text.split(/(`[^`]+`)/).forEach((part, i) => {
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      out.push(<code key={`c${i}`}>{part.slice(1, -1)}</code>);
      return;
    }
    const re =
      /\*\*([^*]+)\*\*|(^|[^*])\*([^*\n]+)\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(part))) {
      const key = `${i}:${m.index}`;
      if (m.index > last) out.push(part.slice(last, m.index));
      if (m[1] !== undefined) out.push(<strong key={key}>{m[1]}</strong>);
      else if (m[3] !== undefined) {
        out.push(m[2], <em key={key}>{m[3]}</em>);
      } else
        out.push(
          <a key={key} href={m[5]} target="_blank" rel="noopener">
            {m[4]}
          </a>,
        );
      last = m.index + m[0].length;
    }
    if (last < part.length) out.push(part.slice(last));
  });
  return out;
}

export function Markdown({ source }: { source: unknown }): ReactElement {
  const lines = String(source).replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = blocks.length;
    if (/^```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={key}>
          <code>{buf.join("\n")}</code>
        </pre>,
      );
    } else if (LIST.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && LIST.test(lines[i])) items.push(lines[i++].replace(LIST, ""));
      const Tag = ordered ? "ol" : "ul";
      blocks.push(
        <Tag key={key}>
          {items.map((item, n) => (
            <li key={n}>{inline(item)}</li>
          ))}
        </Tag>,
      );
    } else if (/^#{1,6}\s+/.test(line)) {
      blocks.push(
        <p key={key}>
          <strong>{inline(line.replace(/^#+\s+/, ""))}</strong>
        </p>,
      );
      i++;
    } else if (!line.trim()) i++;
    else {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim() && !/^```|^\s*([-*]|\d+\.)\s+|^#{1,6}\s/.test(lines[i]))
        buf.push(lines[i++]);
      blocks.push(
        <p key={key}>
          {buf.map((l, n) => (
            <Fragment key={n}>
              {n ? <br /> : null}
              {inline(l)}
            </Fragment>
          ))}
        </p>,
      );
    }
  }
  return <div className="md">{blocks}</div>;
}
