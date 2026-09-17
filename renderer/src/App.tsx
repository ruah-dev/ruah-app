import { useCallback, useEffect, useMemo, useState } from "react";
import { MousePointerClick, Unplug } from "lucide-react";
import type { ArchNode, AgentState } from "./lib/contract/index.js";
import { copyContext, httpOriginFrom } from "./lib/api.js";
import { toGraph, workflowGraph } from "./lib/mapper.js";
import { toRepoTree } from "./lib/repoTree.js";
import { resolveTarget, type DockTarget } from "./lib/dock.js";
import { createStore, type Store } from "./lib/store.js";
import { useStore, newId } from "./ui/useStore.js";
import { AgentPane } from "./ui/AgentPane.js";
import { DiagramCanvas } from "./ui/DiagramCanvas.js";
import { CodeTab, DetailsTab, InspectorTabs, type InspectorTab } from "./ui/Inspector.js";
import { LayerBreadcrumb } from "./ui/LayerBreadcrumb.js";
import { RepoTreeView } from "./ui/RepoTreeView.js";
import { ViewList } from "./ui/ViewList.js";

type View = { kind: "architecture" } | { kind: "workflow"; id: string };

const AGENT_TONE: Record<AgentState, string> = {
  starting: "var(--warn)",
  idle: "var(--ok)",
  busy: "var(--warn)",
  error: "var(--bad)",
  stopped: "var(--bad)",
};

const AGENT_LABEL: Record<AgentState, string> = {
  starting: "starting",
  idle: "idle",
  busy: "working",
  error: "error",
  stopped: "stopped",
};

export function App() {
  const [pair, setPair] = useState<{ store: Store; target: DockTarget } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    resolveTarget()
      .then((target) => {
        if (cancelled) return;
        if (target === null) {
          setError(
            "No daemon found. Start one with `archmap serve <repo>`, pass ?daemon=<ws url>, or run inside the desktop shell.",
          );
          return;
        }
        const store = createStore(target.url);
        store.connect();
        setPair({ store, target });
      })
      .catch(() => {
        if (!cancelled) setError("Could not resolve a daemon target.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (pair === null) {
    return <Splash error={error} />;
  }
  return <Workspace store={pair.store} target={pair.target} />;
}

function Splash({ error }: { error: string | null }) {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
      style={{ backgroundColor: "var(--background)" }}
    >
      <div
        className="mono flex max-w-md items-center gap-2 rounded-[var(--radius)] border px-4 py-3 text-[12px]"
        style={{ borderColor: "var(--hairline)", backgroundColor: "var(--surface-1)" }}
      >
        {error !== null ? (
          <Unplug className="size-4 shrink-0" style={{ color: "var(--bad)" }} />
        ) : (
          <span className="size-2 shrink-0 animate-pulse rounded-full" style={{ backgroundColor: "var(--warn)" }} />
        )}
        <span>{error ?? "Connecting to the archmap daemon…"}</span>
      </div>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="mono h-7 cursor-pointer rounded-[4px] border px-3 text-[11px]"
        style={{ borderColor: "var(--hairline)", color: "var(--muted-foreground)" }}
      >
        Retry
      </button>
    </div>
  );
}

function TopBar({
  arch,
  agent,
  agentInfo,
  mock,
}: {
  arch: { name: string };
  agent: AgentState;
  agentInfo: { name: string; version: string } | null;
  mock: boolean;
}) {
  const tone = AGENT_TONE[agent];
  return (
    <header
      className="flex h-12 shrink-0 items-center gap-3 border-b px-3.5"
      style={{ borderColor: "var(--hairline)", backgroundColor: "var(--surface-1)" }}
    >
      <span
        className="grid size-6 shrink-0 place-items-center rounded-[4px] font-semibold"
        style={{ backgroundColor: "var(--foreground)", color: "var(--background)", fontSize: 11 }}
      >
        a
      </span>
      <span className="text-[13px] font-semibold">Archmap</span>
      <span className="mono truncate rounded-sm px-1.5 py-0.5 text-[11px]" style={{ backgroundColor: "var(--surface-2)", color: "var(--muted-foreground)" }}>
        {arch.name}
      </span>
      {mock ? (
        <span
          className="mono shrink-0 rounded-sm border px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide"
          style={{ borderColor: "var(--warn)", color: "var(--warn)" }}
          title="Scripted demo agent — responses are canned"
        >
          demo
        </span>
      ) : null}
      <span className="mono ml-auto flex shrink-0 items-center gap-1.5 text-[10.5px]" style={{ color: "var(--muted-foreground)" }}>
        <span className="size-1.5 rounded-full" style={{ backgroundColor: tone }} />
        agent {AGENT_LABEL[agent]}
        {agentInfo !== null ? ` · ${agentInfo.name} ${agentInfo.version}` : ""}
      </span>
    </header>
  );
}

function StatusBar({
  connection,
  revision,
  archError,
}: {
  connection: string;
  revision: number;
  archError: string | null;
}) {
  const tone = connection === "open" ? "var(--ok)" : connection === "connecting" ? "var(--warn)" : "var(--bad)";
  return (
    <footer
      className="mono flex h-6 shrink-0 items-center gap-3 border-t px-3 text-[10px]"
      style={{ borderColor: "var(--hairline)", backgroundColor: "var(--surface-1)", color: "var(--muted-foreground)" }}
    >
      <span className="flex items-center gap-1.5">
        <span className="size-1.5 rounded-full" style={{ backgroundColor: tone }} />
        daemon {connection}
      </span>
      <span>revision {revision}</span>
      {archError !== null ? (
        <span className="truncate" style={{ color: "var(--bad)" }}>
          {archError}
        </span>
      ) : null}
      <span className="ml-auto">drag to pan · ⌘+scroll to zoom · double-click to drill in</span>
    </footer>
  );
}

function Workspace({ store, target }: { store: Store; target: DockTarget }) {
  const state = useStore(store);
  const [view, setView] = useState<View>({ kind: "architecture" });
  const [stack, setStack] = useState<(string | null)[]>([null]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<InspectorTab>("details");
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);

  const arch = state.architecture;
  const httpOrigin = httpOriginFrom(target.url);

  useEffect(() => {
    return () => store.close();
  }, [store]);

  const names = useMemo(() => {
    const map: Record<string, string> = {};
    for (const node of arch?.nodes ?? []) map[node.id] = node.name;
    return map;
  }, [arch]);

  const graph = useMemo(() => {
    if (arch === null) return null;
    return view.kind === "workflow"
      ? workflowGraph(arch, view.id)
      : toGraph(arch, stack[stack.length - 1] ?? null);
  }, [arch, view, stack]);

  const selected = useMemo<ArchNode | null>(
    () => arch?.nodes.find((n) => n.id === selectedId) ?? null,
    [arch, selectedId],
  );

  // selection -> focus.set (CONTRACTS §2: daemon logs it, MCP exposes it)
  useEffect(() => {
    store.send({ type: "focus.set", nodeId: selectedId });
  }, [store, selectedId]);

  const streaming = state.turns.some((t) => t.stopReason === undefined);
  const activeTurn = streaming ? (state.turns.find((t) => t.stopReason === undefined) ?? null) : null;
  const nodeTurns = useMemo(
    () => state.turns.filter((t) => t.nodeId === selectedId),
    [state.turns, selectedId],
  );

  if (arch === null || graph === null) {
    return (
      <div className="flex h-full flex-col">
        <Splash
          error={
            state.archError !== null
              ? `architecture.json is invalid: ${state.archError}`
              : null
          }
        />
        <ReconnectBar store={store} />
      </div>
    );
  }

  const selectNode = (id: string | null): void => {
    setSelectedId(id);
    if (id !== null && tab === "code" && (arch.nodes.find((n) => n.id === id)?.files?.length ?? 0) === 0) {
      setTab("details");
    }
  };

  const drillIn = (id: string): void => {
    setStack((s) => [...s, id]);
    setSelectedId(null);
    setView({ kind: "architecture" });
  };

  const copyNodeContext = useCallback((): void => {
    if (selectedId === null || httpOrigin === null) return;
    void copyContext(httpOrigin, selectedId).then((ok) => {
      setCopied(ok);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [selectedId, httpOrigin]);

  const sendPrompt = (text: string): void => {
    if (selectedId === null || text.length === 0 || streaming || state.connection !== "open") return;
    store.send({ type: "prompt", turnId: newId(), nodeId: selectedId, text });
    setDraft("");
  };

  const breadcrumbNames: Record<string, string> =
    view.kind === "workflow"
      ? { ...names, [view.id]: arch.workflows.find((w) => w.id === view.id)?.name ?? view.id }
      : names;

  return (
    <div className="flex h-full flex-col overflow-hidden" style={{ backgroundColor: "var(--background)" }}>
      <TopBar arch={arch} agent={state.agent} agentInfo={state.agentInfo} mock={target.mock} />
      <div className="flex min-h-0 flex-1">
        <aside
          className="flex w-60 shrink-0 flex-col overflow-hidden border-r"
          style={{ borderColor: "var(--hairline)", backgroundColor: "var(--surface-1)" }}
        >
          <ViewList
            workflows={arch.workflows}
            rootActive={view.kind === "architecture" && stack.length === 1}
            activeWorkflow={view.kind === "workflow" ? view.id : null}
            onSelectRoot={() => {
              setView({ kind: "architecture" });
              setStack([null]);
              setSelectedId(null);
            }}
            onSelectWorkflow={(id) => {
              setView({ kind: "workflow", id });
              setSelectedId(null);
            }}
          />
          <RepoTreeView
            tree={toRepoTree(arch)}
            repoName={arch.name}
            activeNodeId={selectedId}
            onOpenNode={(nodeId) => {
              setView({ kind: "architecture" });
              setStack([null]);
              selectNode(nodeId);
              const node = arch.nodes.find((n) => n.id === nodeId);
              setTab((node?.files?.length ?? 0) > 0 ? "code" : "details");
            }}
          />
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <LayerBreadcrumb
            stack={view.kind === "workflow" ? [null, view.id] : stack}
            names={view.kind === "workflow" ? breadcrumbNames : names}
            onJump={(i) => {
              setStack((s) => s.slice(0, i + 1));
              setSelectedId(null);
            }}
            onUp={() => {
              setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
              setSelectedId(null);
            }}
          />
          <DiagramCanvas
            graph={graph}
            selectedId={selectedId}
            onSelect={(node) => selectNode(node.id)}
            onAsk={(node) => {
              setSelectedId(node.id);
              setTab("agent");
            }}
            onDrill={(node) => drillIn(node.id)}
          />
        </main>

        <aside
          className="flex w-[26rem] shrink-0 flex-col overflow-hidden border-l"
          style={{ borderColor: "var(--hairline)", backgroundColor: "var(--surface-1)" }}
        >
          {selected === null ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <span
                className="grid size-9 place-items-center rounded-md border"
                style={{ borderColor: "var(--hairline)", backgroundColor: "var(--surface-2)" }}
              >
                <MousePointerClick className="size-4" style={{ color: "var(--accent)" }} />
              </span>
              <p className="text-[14px] font-medium">Nothing selected</p>
              <p className="text-[11.5px]" style={{ color: "var(--muted-foreground)" }}>
                Click a node to inspect it, open its code, or ask the agent.
              </p>
            </div>
          ) : (
            <>
              <InspectorTabs
                tab={tab}
                onTab={setTab}
                agentBadge={nodeTurns.length > 0 ? String(nodeTurns.length) : null}
              />
              {tab === "details" ? (
                <DetailsTab
                  node={selected}
                  architecture={arch}
                  copied={copied}
                  onCopyContext={copyNodeContext}
                />
              ) : null}
              {tab === "code" ? (
                <CodeTab paths={selected.files ?? []} origin={httpOrigin} />
              ) : null}
              {tab === "agent" ? (
                <AgentPane
                  nodeLabel={selected.name}
                  turns={nodeTurns}
                  streaming={streaming}
                  connected={state.connection === "open" && state.agent === "idle"}
                  draft={draft}
                  onDraft={setDraft}
                  onSend={sendPrompt}
                  onCancel={() => {
                    if (activeTurn !== null) store.send({ type: "cancel", turnId: activeTurn.id });
                  }}
                  permission={activeTurn?.permission ?? null}
                  onAnswer={(requestId, optionId) =>
                    store.send({ type: "permission.response", requestId, optionId })
                  }
                  onDismiss={(requestId) =>
                    store.send({ type: "permission.response", requestId, cancelled: true })
                  }
                  onOpenPath={() => setTab("code")}
                />
              ) : null}
            </>
          )}
        </aside>
      </div>
      <StatusBar connection={state.connection} revision={state.revision} archError={state.archError} />
    </div>
  );
}

function ReconnectBar({ store }: { store: Store }) {
  return (
    <div className="flex justify-center pb-4">
      <button
        type="button"
        onClick={() => store.send({ type: "architecture.get" })}
        className="mono h-7 cursor-pointer rounded-[4px] border px-3 text-[11px]"
        style={{ borderColor: "var(--hairline)", color: "var(--muted-foreground)" }}
      >
        Request architecture
      </button>
    </div>
  );
}
