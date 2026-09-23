// Visual patterns adapted from t3code apps/web/src/components/ChatMarkdown.tsx (MIT)
// A deliberately small markdown renderer for streamed agent text: paragraphs, headings,
// lists, block quotes, fenced code, inline code, bold/italic and links. No HTML passthrough,
// so agent output can never inject markup.
import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type Block =
  | { k: "p"; lines: string[] }
  | { k: "h"; level: number; text: string }
  | { k: "ul"; items: string[] }
  | { k: "ol"; items: string[]; start: number }
  | { k: "quote"; lines: string[] }
  | { k: "code"; lang: string; text: string }
  | { k: "hr" };

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      const close = fence[1]!;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trimStart().startsWith(close)) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1; // closing fence (or end of a still-streaming block)
      blocks.push({ k: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ k: "h", level: heading[1]!.length, text: heading[2]! });
      i += 1;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ k: "hr" });
      i += 1;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*[-*+]\s+/, ""));
        i += 1;
      }
      blocks.push({ k: "ul", items });
      continue;
    }
    const ordered = /^\s*(\d+)[.)]\s+/.exec(line);
    if (ordered) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*\d+[.)]\s+/, ""));
        i += 1;
      }
      blocks.push({ k: "ol", items, start: Number(ordered[1]) });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) {
        quoted.push(lines[i]!.replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push({ k: "quote", lines: quoted });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^\s*(```|~~~|#{1,4}\s|[-*+]\s|\d+[.)]\s|>)/.test(lines[i]!)
    ) {
      para.push(lines[i]!);
      i += 1;
    }
    blocks.push({ k: "p", lines: para });
  }
  return blocks;
}

const looksLikePath = (s: string) =>
  /^[\w@.-]+(\/[\w@.-]+)+(:\d+)?$/.test(s) && /\.[A-Za-z0-9]+(:\d+)?$/.test(s);

function inline(text: string, onOpenPath?: (path: string) => void): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\([^)\s]+\))|(\*[^*\n]+\*)|(_[^_\n]+_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (m[1]) {
      const code = tok.slice(1, -1);
      out.push(
        onOpenPath && looksLikePath(code) ? (
          <button
            key={key++}
            type="button"
            onClick={() => onOpenPath(code.replace(/:\d+$/, ""))}
            className="rounded-[5px] bg-surface-3/70 px-1 py-px font-mono text-[0.86em] text-primary hover:underline"
          >
            {code}
          </button>
        ) : (
          <code
            key={key++}
            className="rounded-[5px] bg-surface-3/70 px-1 py-px font-mono text-[0.86em] text-foreground"
          >
            {code}
          </code>
        ),
      );
    } else if (m[2]) {
      out.push(
        <strong key={key++} className="font-semibold text-foreground">
          {inline(tok.slice(2, -2), onOpenPath)}
        </strong>,
      );
    } else if (m[3]) {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!;
      const href = lm[2]!;
      out.push(
        /^https?:\/\//.test(href) ? (
          <a
            key={key++}
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-primary underline-offset-2 hover:underline"
          >
            {lm[1]}
          </a>
        ) : onOpenPath && !href.includes(":") ? (
          <button
            key={key++}
            type="button"
            onClick={() => onOpenPath(href.replace(/#.*$/, ""))}
            className="text-primary underline-offset-2 hover:underline"
          >
            {lm[1]}
          </button>
        ) : (
          <span key={key++}>{lm[1]}</span>
        ),
      );
    } else {
      out.push(
        <em key={key++} className="italic">
          {tok.slice(1, -1)}
        </em>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({
  text,
  onOpenPath,
  trailing,
  className,
}: {
  text: string;
  onOpenPath?: ((path: string) => void) | undefined;
  /** Rendered at the end of the last block (the streaming cursor). */
  trailing?: ReactNode;
  className?: string;
}) {
  const blocks = parseBlocks(text);
  const tail = (i: number) => (i === blocks.length - 1 ? trailing : null);
  return (
    <div className={cn("space-y-2.5 break-words", className)}>
      {blocks.map((b, i) => {
        switch (b.k) {
          case "p":
            return (
              <p key={i}>
                {b.lines.map((l, j) => (
                  <Fragment key={j}>
                    {j > 0 ? <br /> : null}
                    {inline(l, onOpenPath)}
                  </Fragment>
                ))}
                {tail(i)}
              </p>
            );
          case "h":
            return (
              <p
                key={i}
                className={cn(
                  "pt-1 font-semibold text-foreground",
                  b.level <= 2 ? "text-[14.5px]" : "text-[13.5px]",
                )}
              >
                {inline(b.text, onOpenPath)}
                {tail(i)}
              </p>
            );
          case "ul":
            return (
              <ul key={i} className="list-disc space-y-1 ps-5 marker:text-muted-foreground">
                {b.items.map((it, j) => (
                  <li key={j}>
                    {inline(it, onOpenPath)}
                    {j === b.items.length - 1 ? tail(i) : null}
                  </li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol
                key={i}
                start={b.start}
                className="list-decimal space-y-1 ps-5 marker:text-muted-foreground"
              >
                {b.items.map((it, j) => (
                  <li key={j}>
                    {inline(it, onOpenPath)}
                    {j === b.items.length - 1 ? tail(i) : null}
                  </li>
                ))}
              </ol>
            );
          case "quote":
            return (
              <blockquote
                key={i}
                className="border-s-2 border-hairline ps-3 text-muted-foreground"
              >
                {b.lines.map((l, j) => (
                  <Fragment key={j}>
                    {j > 0 ? <br /> : null}
                    {inline(l, onOpenPath)}
                  </Fragment>
                ))}
                {tail(i)}
              </blockquote>
            );
          case "code":
            return (
              <div key={i} className="overflow-hidden rounded-lg bg-surface-1 ring-1 ring-hairline">
                {b.lang ? (
                  <div className="px-3 pt-2 font-mono text-[10.5px] text-muted-foreground">
                    {b.lang}
                  </div>
                ) : null}
                <pre className="overflow-x-auto px-3 py-2 font-mono text-[12px] leading-[1.6] text-foreground/90">
                  <code>{b.text}</code>
                  {tail(i)}
                </pre>
              </div>
            );
          case "hr":
            return <hr key={i} className="border-hairline" />;
        }
      })}
      {blocks.length === 0 && trailing ? <p>{trailing}</p> : null}
    </div>
  );
}
