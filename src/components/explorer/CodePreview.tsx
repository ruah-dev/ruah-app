import { ExternalLink, FileCode2 } from "lucide-react";
import type { CodeFile } from "@/data/graphs";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

const KEYWORDS = new Set([
  "import",
  "from",
  "export",
  "const",
  "let",
  "var",
  "async",
  "await",
  "function",
  "return",
  "type",
  "interface",
  "if",
  "else",
  "new",
  "extends",
  "as",
  "of",
  "in",
  "class",
  "default",
]);

type Token = { text: string; tone: "plain" | "keyword" | "string" | "comment" | "fn" | "type" };

function tokenizeLine(line: string): Token[] {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//")) return [{ text: line, tone: "comment" }];

  const parts = line.split(/(`[^`]*`|"[^"]*"|'[^']*')/g);
  const tokens: Token[] = [];

  for (const part of parts) {
    if (!part) continue;
    if (/^[`"']/.test(part)) {
      tokens.push({ text: part, tone: "string" });
      continue;
    }
    for (const word of part.split(/(\b)/)) {
      if (!word) continue;
      if (KEYWORDS.has(word)) tokens.push({ text: word, tone: "keyword" });
      else if (/^[A-Z][A-Za-z0-9]*$/.test(word)) tokens.push({ text: word, tone: "type" });
      else tokens.push({ text: word, tone: "plain" });
    }
  }
  return tokens;
}

const toneClass: Record<Token["tone"], string> = {
  plain: "text-foreground/85",
  keyword: "text-node-frontend",
  string: "text-node-data",
  comment: "text-muted-foreground italic",
  fn: "text-node-file",
  type: "text-node-gateway",
};

export function CodePreview({ file, href }: { file: CodeFile; href?: string | undefined }) {
  const lines = file.code.split("\n");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 items-center gap-2 border-b border-hairline px-4">
        <FileCode2 className="size-3.5 shrink-0 text-node-file" />
        <span className="truncate font-mono text-[11.5px] text-foreground">{file.path}</span>
        {file.branch ? (
          <Badge variant="outline" className="ml-auto h-4 rounded-sm px-1 font-mono text-[9.5px]">
            {file.branch}
          </Badge>
        ) : (
          <span className="ml-auto" />
        )}
        {href ? (
          <a
            href={href}
            title="Open in repo (VS Code)"
            className="flex shrink-0 items-center gap-1 font-mono text-[10.5px] text-primary hover:underline"
          >
            Open in repo <ExternalLink className="size-3" />
          </a>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-canvas">
        <pre className="py-2 font-mono text-[11.5px] leading-[1.55]">
          {lines.map((line, i) => {
            const n = i + 1;
            const hot = file.highlight && n >= file.highlight[0] && n <= file.highlight[1];
            return (
              <div
                key={n}
                className={cn(
                  "flex px-3",
                  hot ? "bg-primary/10 shadow-[inset_2px_0_0_0_var(--edge-active)]" : "",
                )}
              >
                <span className="w-8 shrink-0 pr-3 text-right text-muted-foreground/60 select-none">
                  {n}
                </span>
                <code className="whitespace-pre">
                  {tokenizeLine(line).map((t, ti) => (
                    <span key={ti} className={toneClass[t.tone]}>
                      {t.text}
                    </span>
                  ))}
                </code>
              </div>
            );
          })}
        </pre>
      </div>

      {file.deps?.length ? (
        <div className="border-t border-hairline px-3 py-2">
          <p className="pb-1.5 text-[10.5px] tracking-wide text-muted-foreground uppercase">
            Imports
          </p>
          <div className="flex flex-wrap gap-1">
            {file.deps.map((d) => (
              <Badge
                key={d}
                variant="secondary"
                className="h-4.5 rounded-sm px-1.5 font-mono text-[10px]"
              >
                {d}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
