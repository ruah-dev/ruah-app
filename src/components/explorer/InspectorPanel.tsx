import { useMemo } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CornerDownRight,
  MousePointerClick,
  Sparkles,
  Workflow,
} from "lucide-react";
import type { DiagramNode } from "@/data/graphs";
import { codeFilesOf, linksFor, workflowsFor, type NodeLink } from "@/lib/architecture";
import { useWorkspace } from "@/lib/workspace";
import { kindStyles } from "./kinds";
import { CodeTab } from "./CodeTab";
import { AgentPanel } from "@/components/agent/AgentPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

type Props = {
  node: DiagramNode | null;
  contextPath: string;
  tab: string;
  onTabChange: (tab: string) => void;
  onDrill: () => void;
  /** Select another node (inspector links, workflow steps). */
  onSelectNode: (nodeId: string) => void;
  /** Open a repo path: select its owning node and show it in the Code tab. */
  onOpenPath: (path: string) => void;
  /** File the Code tab should show first (from a tool call, the repo tree or the Files list). */
  codePath?: string | null | undefined;
  /** Render one tab only, without the tab strip (pane tabs of type code/agent). */
  only?: "code" | "agent";
  /** Whether this instance owns the permission-card keyboard shortcuts. */
  keyboard?: boolean;
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

function LinkRow({
  link,
  dir,
  onSelect,
}: {
  link: NodeLink;
  dir: "in" | "out";
  onSelect: () => void;
}) {
  const Arrow = dir === "in" ? ArrowLeft : ArrowRight;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-[3px] px-1 py-0.5 text-left hover:bg-surface-2"
      >
        <Arrow className="size-3 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-[11.5px] text-foreground/85">{link.name}</span>
        {link.label ? (
          <span className="truncate font-mono text-[10px] text-muted-foreground">{link.label}</span>
        ) : null}
        {link.kind ? (
          <span className="ml-auto shrink-0 font-mono text-[9.5px] text-muted-foreground/80">
            {link.kind}
          </span>
        ) : null}
      </button>
    </li>
  );
}

export function InspectorPanel({
  node,
  contextPath,
  tab,
  onTabChange,
  onDrill,
  onSelectNode,
  onOpenPath,
  codePath,
  only,
  keyboard = true,
}: Props) {
  const { architecture, daemon, app } = useWorkspace();

  const links = useMemo(
    () => (node ? linksFor(architecture, node.id) : { incoming: [], outgoing: [] }),
    [architecture, node],
  );
  const flows = useMemo(
    () => (node ? workflowsFor(architecture, node.id) : []),
    [architecture, node],
  );
  const parent = node?.parent ? architecture.nodes.find((n) => n.id === node.parent) : undefined;

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
  const files = codeFilesOf({
    ...(node.path !== undefined ? { path: node.path } : {}),
    ...(node.filePaths !== undefined ? { files: node.filePaths } : {}),
  });

  const code = (
    <CodeTab
      node={node}
      repo={app.repo}
      root={daemon.root}
      preferredPath={codePath}
      onDrill={onDrill}
    />
  );
  const agent = (
    <AgentPanel
      node={node}
      contextPath={contextPath}
      daemon={daemon}
      architecture={architecture}
      onOpenPath={onOpenPath}
      keyboard={keyboard}
    />
  );

  if (only === "code") return <div className="flex h-full min-h-0 flex-col">{code}</div>;
  if (only === "agent") return <div className="flex h-full min-h-0 flex-col">{agent}</div>;

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
          <Button
            variant="outline"
            size="sm"
            className="h-6 gap-1 rounded-[4px] px-1.5 text-[10.5px]"
            onClick={onDrill}
          >
            <CornerDownRight className="size-3" />
            Drill
          </Button>
        ) : null}
      </div>

      <Tabs value={tab} onValueChange={onTabChange} className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList className="h-9 w-full justify-start gap-4 rounded-none border-b border-hairline bg-transparent px-4">
          <TabsTrigger
            value="details"
            className="h-9 rounded-none border-b border-transparent px-0 text-[11px] data-[state=active]:border-primary data-[state=active]:bg-transparent"
          >
            Details
          </TabsTrigger>
          <TabsTrigger
            value="code"
            className="h-9 rounded-none border-b border-transparent px-0 text-[11px] data-[state=active]:border-primary data-[state=active]:bg-transparent"
          >
            Code
          </TabsTrigger>
          <TabsTrigger
            value="agent"
            className="h-9 gap-1 rounded-none border-b border-transparent px-0 text-[11px] data-[state=active]:border-primary data-[state=active]:bg-transparent"
          >
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
                <dd className="font-mono text-[11.5px]">
                  {node.type &&
                  node.type !== node.kind &&
                  !(node.type === "datastore" && node.kind === "database")
                    ? `${node.type} (${style.label})`
                    : style.label}
                </dd>
              </div>
              {node.owner ? (
                <div className="flex gap-2">
                  <dt className="w-16 shrink-0 text-[11px] text-muted-foreground">owner</dt>
                  <dd className="font-mono text-[11.5px]">{node.owner}</dd>
                </div>
              ) : null}
              <div className="flex gap-2">
                <dt className="w-16 shrink-0 text-[11px] text-muted-foreground">path</dt>
                <dd className="truncate font-mono text-[11.5px] text-primary" title={contextPath}>
                  {node.path ?? "—"}
                </dd>
              </div>
              {node.layer ? (
                <div className="flex gap-2">
                  <dt className="w-16 shrink-0 text-[11px] text-muted-foreground">layer</dt>
                  <dd className="font-mono text-[11.5px]">{node.layer}</dd>
                </div>
              ) : null}
              {parent ? (
                <div className="flex gap-2">
                  <dt className="w-16 shrink-0 text-[11px] text-muted-foreground">inside</dt>
                  <dd>
                    <button
                      type="button"
                      onClick={() => onSelectNode(parent.id)}
                      className="font-mono text-[11.5px] text-foreground/85 hover:underline"
                    >
                      {parent.name}
                    </button>
                  </dd>
                </div>
              ) : null}
              <div className="flex gap-2">
                <dt className="w-16 shrink-0 text-[11px] text-muted-foreground">id</dt>
                <dd className="font-mono text-[11.5px] text-muted-foreground">{node.id}</dd>
              </div>
            </dl>
          </Section>
          {node.tech?.length ? (
            <>
              <Separator className="bg-hairline" />
              <Section title="Stack">
                <div className="flex flex-wrap gap-1">
                  {node.tech.map((t) => (
                    <Badge
                      key={t}
                      variant="secondary"
                      className="h-4.5 rounded-sm px-1.5 font-mono text-[10px]"
                    >
                      {t}
                    </Badge>
                  ))}
                </div>
              </Section>
            </>
          ) : null}
          {node.notes ? (
            <>
              <Separator className="bg-hairline" />
              <Section title="Notes">
                <p className="text-[12px] leading-relaxed whitespace-pre-wrap text-foreground/85">
                  {node.notes}
                </p>
              </Section>
            </>
          ) : null}
          {files.length ? (
            <>
              <Separator className="bg-hairline" />
              <Section title={`Files · ${files.length}`}>
                <ul className="space-y-0.5">
                  {files.map((f) => (
                    <li key={f}>
                      <button
                        type="button"
                        onClick={() => onOpenPath(f)}
                        className="block max-w-full truncate font-mono text-[11px] text-primary hover:underline"
                        title={f}
                      >
                        {f}
                      </button>
                    </li>
                  ))}
                </ul>
              </Section>
            </>
          ) : null}
          {links.incoming.length || links.outgoing.length ? (
            <>
              <Separator className="bg-hairline" />
              <Section title="Links">
                <ul className="space-y-0.5">
                  {links.incoming.map((l, i) => (
                    <LinkRow
                      key={`in-${i}`}
                      link={l}
                      dir="in"
                      onSelect={() => onSelectNode(l.nodeId)}
                    />
                  ))}
                  {links.outgoing.map((l, i) => (
                    <LinkRow
                      key={`out-${i}`}
                      link={l}
                      dir="out"
                      onSelect={() => onSelectNode(l.nodeId)}
                    />
                  ))}
                </ul>
              </Section>
            </>
          ) : null}
          {flows.length ? (
            <>
              <Separator className="bg-hairline" />
              <Section title="Workflows">
                <ul className="space-y-1">
                  {flows.map((w) => (
                    <li
                      key={w.id}
                      className="flex items-center gap-1.5 text-[11.5px] text-foreground/85"
                    >
                      <Workflow className="size-3 text-muted-foreground" />
                      {w.name}
                      <span className="font-mono text-[10px] text-muted-foreground">
                        step {w.steps.indexOf(node.id) + 1} of {w.steps.length}
                      </span>
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
          {code}
        </TabsContent>

        <TabsContent value="agent" className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {agent}
        </TabsContent>
      </Tabs>
    </div>
  );
}
