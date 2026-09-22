import { useState } from "react";
import { ArrowUp, Bot, CornerDownRight, MousePointerClick, Sparkles, User } from "lucide-react";
import type { DiagramNode } from "@/data/graphs";
import { kindStyles } from "./kinds";
import { CodePreview } from "./CodePreview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  context?: string;
};

type Props = {
  node: DiagramNode | null;
  contextPath: string;
  tab: string;
  onTabChange: (tab: string) => void;
  thread: ChatMessage[];
  onSend: (prompt: string) => void;
  onDrill: () => void;
};

const toneClass = { ok: "text-ok", warn: "text-warn", bad: "text-bad" } as const;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-4">
      <p className="pb-2 text-[9.5px] font-semibold text-muted-foreground uppercase">{title}</p>
      {children}
    </div>
  );
}

export function InspectorPanel({
  node,
  contextPath,
  tab,
  onTabChange,
  thread,
  onSend,
  onDrill,
}: Props) {
  const [draft, setDraft] = useState("");

  if (!node) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <span className="grid size-9 place-items-center rounded-md border border-hairline bg-surface-2">
          <MousePointerClick className="size-4 text-primary" />
        </span>
        <p className="font-display text-[14px] font-medium text-foreground">Nothing selected</p>
        <p className="text-[11.5px] text-muted-foreground">
          Click any element on the diagram to inspect it, open its code, or ask the agent about it.
        </p>
      </div>
    );
  }

  const style = kindStyles[node.kind];
  const Icon = style.icon;
  const file = node.files?.[0];

  const send = () => {
    if (!draft.trim()) return;
    onSend(draft.trim());
    setDraft("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 items-center gap-3 border-b border-hairline px-4">
        <span className="grid size-7 shrink-0 place-items-center rounded-[4px] border border-hairline bg-surface-2">
          <Icon className={cn("size-4", style.color)} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-[13px] font-medium">{node.label}</p>
          <p className="truncate text-[10.5px] text-muted-foreground">{node.subtitle}</p>
        </div>
        {node.drill ? (
            <Button variant="outline" size="sm" className="h-6 gap-1 rounded-[4px] px-1.5 text-[10.5px]" onClick={onDrill}>
            <CornerDownRight className="size-3" />
            Drill
          </Button>
        ) : null}
      </div>

      <Tabs value={tab} onValueChange={onTabChange} className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList className="h-9 w-full justify-start gap-4 rounded-none border-b border-hairline bg-transparent px-4">
          <TabsTrigger value="details" className="h-9 rounded-none border-b border-transparent px-0 text-[11px] data-[state=active]:border-primary data-[state=active]:bg-transparent">
            Details
          </TabsTrigger>
          <TabsTrigger value="code" className="h-9 rounded-none border-b border-transparent px-0 text-[11px] data-[state=active]:border-primary data-[state=active]:bg-transparent">
            Code
          </TabsTrigger>
          <TabsTrigger value="agent" className="h-9 gap-1 rounded-none border-b border-transparent px-0 text-[11px] data-[state=active]:border-primary data-[state=active]:bg-transparent">
            <Sparkles className="size-3" />
            Agent
          </TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="min-h-0 flex-1 overflow-auto">
          {node.description ? (
            <Section title="What it does">
              <p className="text-[12px] leading-relaxed text-foreground/85">{node.description}</p>
            </Section>
          ) : null}
          <Separator className="bg-hairline" />
          <Section title="Facts">
            <dl className="space-y-1.5">
              <div className="flex gap-2">
                <dt className="w-16 shrink-0 text-[11px] text-muted-foreground">type</dt>
                <dd className="font-mono text-[11.5px]">{style.label}</dd>
              </div>
              {node.owner ? (
                <div className="flex gap-2">
                  <dt className="w-16 shrink-0 text-[11px] text-muted-foreground">owner</dt>
                  <dd className="font-mono text-[11.5px]">{node.owner}</dd>
                </div>
              ) : null}
              <div className="flex gap-2">
                <dt className="w-16 shrink-0 text-[11px] text-muted-foreground">path</dt>
                <dd className="truncate font-mono text-[11.5px] text-primary">{contextPath}</dd>
              </div>
            </dl>
          </Section>
          {node.tech?.length ? (
            <>
              <Separator className="bg-hairline" />
              <Section title="Stack">
                <div className="flex flex-wrap gap-1">
                  {node.tech.map((t) => (
                    <Badge key={t} variant="secondary" className="h-4.5 rounded-sm px-1.5 font-mono text-[10px]">
                      {t}
                    </Badge>
                  ))}
                </div>
              </Section>
            </>
          ) : null}
          {node.endpoints?.length ? (
            <>
              <Separator className="bg-hairline" />
              <Section title="Endpoints">
                <ul className="space-y-1">
                  {node.endpoints.map((e) => (
                    <li key={e} className="font-mono text-[11.5px] text-foreground/85">
                      {e}
                    </li>
                  ))}
                </ul>
              </Section>
            </>
          ) : null}
          {node.health?.length ? (
            <>
              <Separator className="bg-hairline" />
              <Section title="Signals">
                <div className="flex flex-wrap gap-1.5">
                  {node.health.map((h) => (
                    <span
                      key={h.label}
                      className={cn(
                        "flex items-center gap-1.5 rounded-[3px] border border-hairline bg-surface-2 px-1.5 py-0.5 font-mono text-[10px]",
                        toneClass[h.tone],
                      )}
                    >
                      <span className="size-1.5 rounded-full bg-current" />
                      {h.label}
                    </span>
                  ))}
                </div>
              </Section>
            </>
          ) : null}
        </TabsContent>

        <TabsContent value="code" className="min-h-0 flex-1 overflow-hidden">
          {file ? (
            <CodePreview file={file} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <p className="text-[12px] text-foreground">No file attached to this element</p>
              <p className="text-[11.5px] text-muted-foreground">
                Drill in until you reach a file node to read source here.
              </p>
              {node.drill ? (
                <Button variant="outline" size="sm" className="mt-1 h-6 text-[11px]" onClick={onDrill}>
                  Drill in
                </Button>
              ) : null}
            </div>
          )}
        </TabsContent>

        <TabsContent value="agent" className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="min-h-0 flex-1 space-y-3 overflow-auto px-3 py-3">
            {thread.length === 0 ? (
              <p className="text-[11.5px] text-muted-foreground">
                Ask anything about this element. Context from the diagram is attached automatically.
              </p>
            ) : null}
            {thread.map((m) => (
              <div key={m.id} className="flex gap-2">
                <div className="mt-0.5 shrink-0">
                  {m.role === "user" ? (
                    <User className="size-3.5 text-muted-foreground" />
                  ) : (
                    <Bot className="size-3.5 text-primary" />
                  )}
                </div>
                <div className="min-w-0">
                  {m.context ? (
                    <Badge
                      variant="outline"
                      className="mb-1 h-4 rounded-sm border-primary/40 bg-primary/10 px-1 font-mono text-[9.5px] text-primary"
                    >
                      @{m.context}
                    </Badge>
                  ) : null}
                  <p
                    className={cn(
                      "text-[12px] leading-relaxed whitespace-pre-wrap",
                      m.role === "user" ? "text-foreground" : "text-foreground/80",
                    )}
                  >
                    {m.text}
                  </p>
                </div>
              </div>
            ))}
          </div>
          <div className="border-t border-hairline bg-surface-1 p-3">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={2}
              placeholder={`Ask about ${node.label}…`}
              className="resize-none rounded-md border-hairline bg-surface-2 font-mono text-[11.5px] shadow-none"
            />
            <div className="flex items-center justify-between pt-1.5">
              <span className="truncate font-mono text-[10px] text-primary">@{contextPath}</span>
              <Button size="sm" className="h-6 gap-1 px-2 text-[11px]" onClick={send}>
                Send <ArrowUp className="size-3" />
              </Button>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
