// Per agent: for each agent, what Ruah injects into its sessions right now (from the enabled
// extensions) next to what the agent already has configured on its own (read-only discovery of
// its config files). The two together are what a session of that agent can use.
import { useEffect, useState } from "react";
import { CircleAlert, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  AGENT_LABEL,
  EXTENSION_AGENTS,
  KIND_LABEL,
  describeServer,
  type AgentDiscovery,
  type ExtensionAgent,
  type ExtensionsApi,
  type Load,
  type SessionPreview,
} from "@/lib/extensions";
import { Chip, KindMark } from "./parts";

function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

function Injected({ preview }: { preview: SessionPreview | undefined }) {
  if (preview === undefined) return <p className="text-label text-muted-foreground">Loading…</p>;
  const empty = preview.servers.length + preview.plugins.length + preview.rules.length === 0;
  return (
    <div className="space-y-1.5">
      {empty ? <p className="text-label text-muted-foreground">Nothing yet — enable extensions for this agent on the Installed tab.</p> : null}
      {preview.servers.map((s) => (
        <div key={s.name} className="flex min-w-0 items-center gap-2">
          <KindMark kind="mcp" className="size-5 rounded-md [&>svg]:size-3" />
          <span className="shrink-0 text-ui-sm text-foreground">{s.name}</span>
          <span className="min-w-0 truncate font-mono text-meta text-muted-foreground" title={describeServer(s)}>
            {describeServer(s)}
          </span>
        </div>
      ))}
      {preview.plugins.map((p) => (
        <div key={p} className="flex min-w-0 items-center gap-2">
          <KindMark kind="plugin" className="size-5 rounded-md [&>svg]:size-3" />
          <span className="min-w-0 truncate text-ui-sm text-foreground" title={p}>
            {basename(p).startsWith(`${preview.agent}-`) ? `Ruah skills plugin (${preview.skills.length} skill${preview.skills.length === 1 ? "" : "s"})` : basename(p)}
          </span>
        </div>
      ))}
      {preview.rules.map((r) => (
        <div key={r} className="flex min-w-0 items-center gap-2">
          <KindMark kind="rule" className="size-5 rounded-md [&>svg]:size-3" />
          <span className="min-w-0 truncate text-ui-sm text-foreground" title={r}>
            {basename(r)}
          </span>
        </div>
      ))}
      {preview.skipped.map((s) => (
        <p key={s.id} className="flex items-start gap-1.5 text-label text-warn">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" /> {s.id}: {s.reason}
        </p>
      ))}
      {preview.notes.map((n) => (
        <p key={n} className="text-meta text-muted-foreground">
          {n}
        </p>
      ))}
    </div>
  );
}

const COLLAPSED = 8;
const KIND_ORDER = ["mcp", "plugin", "power", "skill", "rule"] as const;

function Own({ discovery }: { discovery: AgentDiscovery | undefined }) {
  const [all, setAll] = useState(false);
  if (discovery === undefined) return <p className="text-label text-muted-foreground">Loading…</p>;
  if (discovery.items.length === 0) return <p className="text-label text-muted-foreground">Nothing configured in {discovery.name} itself.</p>;
  // MCP servers and plugins first: they are what runs.
  const items = [...discovery.items].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  const shown = all ? items : items.slice(0, COLLAPSED);
  return (
    <div className="space-y-1">
      {shown.map((item, i) => (
        <div key={`${item.source}-${item.name}-${i}`} className="flex min-w-0 items-center gap-2">
          <KindMark kind={item.kind} className="size-5 rounded-md [&>svg]:size-3" />
          <span className={cn("min-w-0 max-w-[55%] shrink truncate text-ui-sm", item.enabled === false ? "text-faint line-through" : "text-foreground")} title={item.name}>
            {item.name}
          </span>
          <Chip>{item.scope === "project" ? "project" : "user"}</Chip>
          <span className="min-w-0 flex-1 truncate font-mono text-meta text-faint" title={item.runs !== undefined ? describeServer(item.runs) : item.source}>
            {item.runs !== undefined ? describeServer(item.runs) : item.source}
          </span>
        </div>
      ))}
      {items.length > COLLAPSED ? (
        <button type="button" className="text-label text-muted-foreground transition-colors hover:text-foreground" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${items.length}`}
        </button>
      ) : null}
      {discovery.errors.map((e) => (
        <p key={e} className="text-meta text-bad">
          {e}
        </p>
      ))}
    </div>
  );
}

export function PerAgentView({
  api,
  discovery,
  loadDiscovery,
  version,
}: {
  api: ExtensionsApi;
  discovery: Load<AgentDiscovery[]>;
  loadDiscovery: () => Promise<void>;
  /** Changes whenever the installed list changes, so previews refresh. */
  version: string;
}) {
  const [previews, setPreviews] = useState<Partial<Record<ExtensionAgent, SessionPreview>>>({});
  const [loading, setLoading] = useState(false);

  // Loads on first view and again after a project switch (the page resets it to idle).
  useEffect(() => {
    if (discovery.status === "idle") void loadDiscovery();
  }, [discovery.status, loadDiscovery]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all(EXTENSION_AGENTS.map(async (agent) => [agent, await api.preview(agent)] as const)).then((results) => {
      if (cancelled) return;
      const next: Partial<Record<ExtensionAgent, SessionPreview>> = {};
      for (const [agent, r] of results) if (r.ok) next[agent] = r.data;
      setPreviews(next);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [api, version]);

  const byAgent = discovery.status === "ok" ? new Map(discovery.data.map((d) => [d.id, d])) : new Map<ExtensionAgent, AgentDiscovery>();
  return (
    <div className="flex flex-col gap-4">
      {discovery.status === "error" ? <p className="text-ui-sm text-bad">{discovery.message}</p> : null}
      {EXTENSION_AGENTS.map((agent) => {
        const d = byAgent.get(agent);
        const counts = d?.items.reduce<Record<string, number>>((acc, item) => ({ ...acc, [item.kind]: (acc[item.kind] ?? 0) + 1 }), {}) ?? {};
        return (
          <section key={agent} className="card-warm px-4 py-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="heading text-title text-foreground">{AGENT_LABEL[agent]}</h2>
              {d !== undefined && !d.installed ? <Chip tone="warn">Not installed</Chip> : null}
              <span className="flex-1" />
              <span className="text-meta text-faint">
                {Object.entries(counts)
                  .map(([kind, n]) => `${n} ${KIND_LABEL[kind as keyof typeof KIND_LABEL].toLowerCase()}${n === 1 ? "" : "s"}`)
                  .join(" · ")}
              </span>
              {loading ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
            </div>
            <div className="mt-3 grid gap-4 md:grid-cols-2">
              <div className="min-w-0 space-y-2">
                <p className="eyebrow">From Ruah · each session</p>
                <Injected preview={previews[agent]} />
              </div>
              <div className="min-w-0 space-y-2">
                <p className="eyebrow">Its own configuration</p>
                <Own discovery={d} />
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}
