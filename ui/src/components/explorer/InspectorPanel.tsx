import { useMemo, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, CornerDownRight, MousePointerClick, Workflow, SquareTerminal } from "lucide-react";
import type { DiagramNode } from "@/data/graphs";
import { codeFilesOf, linksFor, workflowsFor, type NodeLink } from "@/lib/architecture";
import { useWorkspace } from "@/lib/workspace";
import { kindStyles } from "./kinds";
import { CodeTab } from "./CodeTab";
import { AgentPanel } from "@/components/agent/AgentPanel";
import { CloudResourceDetails, ElementIntegrations } from "@/components/integrations/ElementIntegrations";
import { isCloudNodeId } from "@/lib/integrations";
import { cn } from "@/lib/utils";
import { openElementInTerminal } from "@/components/terminal/actions";

export type InspectorView = "agent" | "details" | "code";

type Props = {
  node: DiagramNode | null;
  contextPath: string;
  view: InspectorView;
  onDrill: () => void;
  /** Select another node (inspector links, workflow steps). */
  onSelectNode: (nodeId: string) => void;
  /** Open a repo path: select its owning node and show it in the Code view. */
  onOpenPath: (path: string) => void;
  /** Clear the selection (the composer's context chip). */
  onClearContext?: (() => void) | undefined;
  /** File the Code view should show first (from a tool call, the repo tree or the Files list). */
  codePath?: string | null | undefined;
  /** Lines to highlight in that file (a symbol's range). */
  codeRange?: [number, number] | null | undefined;
  /** Whether this instance owns the permission-card keyboard shortcuts. */
  keyboard?: boolean;
  /** Bumped by "Ask agent" to focus the composer. */
  focusSignal?: number;
  focusTurnId?: string | null;
};

const toneClass = { ok: "text-ok", warn: "text-warn", bad: "text-bad" } as const;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-label font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
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
        className="-mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-accent"
      >
        <Arrow className="size-3 shrink-0 text-faint" />
        <span className="truncate text-ui-sm text-foreground/90">{link.name}</span>
        {link.label ? (
          <span className="truncate text-meta text-muted-foreground">{link.label}</span>
        ) : null}
        {link.kind ? (
          <span className="ms-auto shrink-0 text-caption text-faint">{link.kind}</span>
        ) : null}
      </button>
    </li>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
      <MousePointerClick className="size-5 text-faint" />
      <p className="heading text-title text-foreground">{title}</p>
      <p className="text-ui-sm leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}

function Details({
  node,
  contextPath,
  onDrill,
  onSelectNode,
  onOpenPath,
}: Pick<Props, "contextPath" | "onDrill" | "onSelectNode" | "onOpenPath"> & {
  node: DiagramNode;
}) {
  const { mapArchitecture: architecture } = useWorkspace();
  const links = useMemo(() => linksFor(architecture, node.id), [architecture, node]);
  const flows = useMemo(() => workflowsFor(architecture, node.id), [architecture, node]);
  const parent = node.parent ? architecture.nodes.find((n) => n.id === node.parent) : undefined;
  const style = kindStyles[node.kind];
  const Icon = style.icon;
  const files = codeFilesOf({
    ...(node.path !== undefined ? { path: node.path } : {}),
    ...(node.filePaths !== undefined ? { files: node.filePaths } : {}),
  });
  const typeLabel =
    node.type && node.type !== node.kind && !(node.type === "datastore" && node.kind === "database")
      ? `${node.type} (${style.label})`
      : style.label;

  const facts: [string, ReactNode][] = [
    ["Type", typeLabel],
    [
      "Path",
      <span className="font-mono text-label text-foreground/90" title={contextPath}>
        {node.path ?? "—"}
      </span>,
    ],
  ];
  if (node.owner) facts.push(["Owner", node.owner]);
  if (node.layer) facts.push(["Layer", node.layer]);
  if (parent)
    facts.push([
      "Inside",
      <button
        type="button"
        onClick={() => onSelectNode(parent.id)}
        className="text-foreground/90 hover:underline"
      >
        {parent.name}
      </button>,
    ]);
  if (node.tech?.length) facts.push(["Stack", node.tech.join(" · ")]);
  facts.push(["ID", <span className="font-mono text-label text-muted-foreground">{node.id}</span>]);

  return (
    <div className="space-y-6 px-5 pt-5 pb-8">
      <div className="space-y-3">
        <div className="flex items-start gap-3">
          <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg", style.tint)}>
            <Icon className={cn("size-4", style.color)} />
          </span>
          <div className="min-w-0 flex-1 pt-px">
            <p className="heading truncate text-headline text-foreground">{node.label}</p>
            {node.subtitle ? (
              <p className="truncate text-ui-sm text-muted-foreground">{node.subtitle}</p>
            ) : null}
          </div>
          {node.path || node.filePaths?.length ? (
            <button
              type="button"
              onClick={() => openElementInTerminal(node)}
              title="Open a terminal in this element's folder"
              className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-label text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <SquareTerminal className="size-3.5" />
              Terminal
            </button>
          ) : null}
          {node.drill ? (
            <button
              type="button"
              onClick={onDrill}
              className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-label text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <CornerDownRight className="size-3.5" />
              Open level
            </button>
          ) : null}
        </div>
        {node.description ? (
          <p className="text-ui leading-relaxed text-foreground/85">{node.description}</p>
        ) : null}
      </div>

      <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-ui-sm">
        {facts.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="min-w-0 truncate text-foreground/90">{v}</dd>
          </div>
        ))}
      </dl>

      {node.notes ? (
        <Section title="Notes">
          <p className="text-ui leading-relaxed whitespace-pre-wrap text-foreground/85">
            {node.notes}
          </p>
        </Section>
      ) : null}

      {files.length ? (
        <Section title="Files">
          <ul>
            {files.map((f) => (
              <li key={f}>
                <button
                  type="button"
                  onClick={() => onOpenPath(f)}
                  className="-mx-1.5 block w-[calc(100%+0.75rem)] truncate rounded-md px-1.5 py-0.5 text-left font-mono text-label text-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
                  title={f}
                >
                  {f}
                </button>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {links.incoming.length || links.outgoing.length ? (
        <Section title="Links">
          <ul>
            {links.incoming.map((l, i) => (
              <LinkRow key={`in-${i}`} link={l} dir="in" onSelect={() => onSelectNode(l.nodeId)} />
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
      ) : null}

      {flows.length ? (
        <Section title="Workflows">
          <ul className="space-y-1">
            {flows.map((w) => (
              <li key={w.id} className="flex items-center gap-2 text-ui-sm text-foreground/90">
                <Workflow className="size-3.5 text-faint" />
                {w.name}
                <span className="text-meta text-muted-foreground">
                  step {w.steps.indexOf(node.id) + 1} of {w.steps.length}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {node.health?.length ? (
        <Section title="Signals">
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {node.health.map((h) => (
              <span
                key={h.label}
                className={cn("flex items-center gap-1.5 text-label", toneClass[h.tone])}
              >
                <span className="size-1.5 rounded-full bg-current" />
                {h.label}
              </span>
            ))}
          </div>
        </Section>
      ) : null}

      <ElementIntegrations node={node} />
    </div>
  );
}

export function InspectorPanel({
  node,
  contextPath,
  view,
  onDrill,
  onSelectNode,
  onOpenPath,
  onClearContext,
  codePath,
  codeRange,
  keyboard = true,
  focusSignal = 0,
  focusTurnId = null,
}: Props) {
  const { mapArchitecture: architecture, daemon, app } = useWorkspace();

  if (view === "agent") {
    return (
      <AgentPanel
        node={node}
        contextPath={contextPath}
        daemon={daemon}
        architecture={architecture}
        onOpenPath={onOpenPath}
        onClearContext={onClearContext}
        focusSignal={focusSignal}
        focusTurnId={focusTurnId}
        keyboard={keyboard}
      />
    );
  }

  if (!node) {
    return (
      <EmptyState
        title="Nothing selected"
        body={
          view === "code"
            ? "Select an element on the map to read its source."
            : "Select an element on the map to see what it is, what it talks to and where it lives."
        }
      />
    );
  }

  if (view === "code") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <CodeTab
          node={node}
          repo={app.repo}
          root={daemon.root}
          preferredPath={codePath}
          range={codeRange}
          onDrill={onDrill}
        />
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      {isCloudNodeId(node.id) ? (
        <CloudResourceDetails node={node} />
      ) : (
        <Details
          node={node}
          contextPath={contextPath}
          onDrill={onDrill}
          onSelectNode={onSelectNode}
          onOpenPath={onOpenPath}
        />
      )}
    </div>
  );
}
