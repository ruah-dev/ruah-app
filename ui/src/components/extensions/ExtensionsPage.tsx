// Extensions (CONTRACTS.md §15): skills, MCP servers, Kiro powers, plugins and rules for every
// agent Ruah runs. Three views — Installed (cards with per-agent switches and exactly what each
// runs), Discover (the curated catalog + your own), Per agent (what each agent gets from Ruah
// next to its own config). Self-contained: its own header, no shell imports, so it can live in
// a rail entry, a panel slot or a dialog.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw, Search, X } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Phantom } from "@/components/brand/Phantom";
import { cn } from "@/lib/utils";
import { matchesQuery, useExtensions, type ExtensionAgent, type ExtensionView, type FeaturedExtension } from "@/lib/extensions";
import { AddExtensionDialog, type SourceKind } from "./AddExtensionDialog";
import { DiscoverView } from "./DiscoverView";
import { ExtensionCard } from "./ExtensionCard";
import { PerAgentView } from "./PerAgentView";
import { Segmented, fieldClass, primaryButton, quietButton } from "./parts";

export type ExtensionsTab = "installed" | "discover" | "agents";

function EmptyInstalled({ onBrowse }: { onBrowse: () => void }) {
  return (
    <div className="flex items-center gap-4 rounded-xl border border-hairline bg-surface-1 px-4 py-4">
      <Phantom expression="idle" size="md" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-ui font-medium text-foreground">No extensions yet</p>
        <p className="text-ui-sm leading-relaxed text-muted-foreground">
          Give your agents more tools: Claude Design, GitHub, Playwright, your own skills. Nothing runs until you turn it on for an agent.
        </p>
      </div>
      <button type="button" className={primaryButton} onClick={onBrowse}>
        Browse
      </button>
    </div>
  );
}

export function ExtensionsPage({ initialTab = "installed" }: { initialTab?: ExtensionsTab }) {
  const x = useExtensions();
  const [tab, setTab] = useState<ExtensionsTab>(initialTab);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState<{ featured: FeaturedExtension | null; source?: SourceKind } | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: "ok" | "bad" } | null>(null);

  useEffect(() => {
    if (tab === "discover") void x.loadFeatured();
  }, [tab, x.loadFeatured]);

  useEffect(() => {
    if (message === null) return;
    const timer = setTimeout(() => setMessage(null), 6000);
    return () => clearTimeout(timer);
  }, [message]);

  const data = x.list.status === "ok" ? x.list.data : null;
  const installedAgents = useMemo(() => Object.fromEntries((data?.agents ?? []).map((a) => [a.id, a.installed])) as Partial<Record<ExtensionAgent, boolean>>, [data]);
  const filtered = useMemo(() => (data?.installed ?? []).filter((e) => matchesQuery(e, query)), [data, query]);
  const groups = useMemo(
    () =>
      [
        { scope: "project" as const, title: data?.project !== null && data?.project !== undefined ? `This project · ${data.project.name}` : "This project", hint: ".ruah/extensions.json — committable, no secrets", items: filtered.filter((e) => e.scope === "project") },
        { scope: "global" as const, title: "All projects", hint: "On this machine", items: filtered.filter((e) => e.scope === "global") },
      ].filter((g) => g.items.length > 0),
    [data, filtered],
  );
  // Previews on the Per agent tab refresh whenever the installed list changes.
  const version = useMemo(() => JSON.stringify((data?.installed ?? []).map((e) => [e.scope, e.id, e.enabledFor, e.status])), [data]);

  const onAdded = useCallback(
    (view: ExtensionView) => {
      setTab("installed");
      setHighlight(`${view.scope}/${view.id}`);
      setMessage({ text: `Added ${view.name}${view.enabledFor.length > 0 ? ` and enabled it for ${view.enabledFor.length} agent${view.enabledFor.length === 1 ? "" : "s"}` : " — turn it on for an agent below"}.`, tone: "ok" });
      void x.reload();
      void x.loadFeatured();
    },
    [x],
  );

  const onChanged = useCallback(async () => {
    await x.reload();
  }, [x]);

  const noDaemon = x.origin === null;
  const count = data?.installed.length ?? 0;
  const reviewCount = data?.installed.filter((e) => e.status === "review").length ?? 0;

  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-bar shrink-0 items-center gap-3 border-b border-hairline px-5 max-md:h-11 max-md:px-3">
          <h1 className="heading min-w-0 truncate text-title text-foreground max-md:hidden">Extensions</h1>
          <Segmented
            label="Extensions view"
            value={tab}
            onChange={setTab}
            options={[
              { value: "installed", label: <>Installed{count > 0 ? <span className="text-faint">{count}</span> : null}{reviewCount > 0 ? <span className="size-1.5 rounded-full bg-warn" aria-label={`${reviewCount} need review`} /> : null}</> },
              { value: "discover", label: "Discover" },
              { value: "agents", label: "Per agent" },
            ]}
          />
          <span className="flex-1" />
          {tab !== "agents" ? (
            <div className="relative max-sm:hidden">
              <Search className="pointer-events-none absolute start-2 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
              <input
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                placeholder={tab === "discover" ? "Search the catalog" : "Search extensions"}
                aria-label="Search extensions"
                className={cn(fieldClass, "h-7 w-52 ps-7 pe-7 text-ui-sm")}
              />
              {query.length > 0 ? (
                <button type="button" className="absolute end-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-faint hover:text-foreground" aria-label="Clear search" onClick={() => setQuery("")}>
                  <X className="size-3" />
                </button>
              ) : null}
            </div>
          ) : null}
          <button type="button" className={quietButton} aria-label="Refresh" disabled={noDaemon} onClick={() => void x.reload()}>
            <RefreshCw className={cn("size-3.5", x.list.status === "loading" && "animate-spin")} />
          </button>
          <button type="button" className={primaryButton} disabled={noDaemon} onClick={() => setAdding({ featured: null })}>
            <Plus className="size-3.5" /> Add
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-8 max-md:px-4">
            <div className="space-y-2">
              <p className="eyebrow">Skills · MCP servers · Powers · Plugins · Rules</p>
              <p className="text-body leading-relaxed text-muted-foreground">
                Add once, turn on per agent. Ruah hands them to Claude Code, Cursor, Grok, Kiro and OpenCode when a session starts — without touching their own settings unless you ask it to.
              </p>
            </div>

            {noDaemon ? (
              <div className="rounded-xl border border-hairline bg-surface-1 px-4 py-3 text-ui-sm text-muted-foreground">
                Connect to the Ruah daemon to manage extensions (or use <span className="font-mono text-foreground">ruah app ext</span> in a terminal).
              </div>
            ) : null}
            {x.list.status === "error" ? <p className="text-ui-sm text-bad">{x.list.message}</p> : null}
            {data?.errors.map((e) => (
              <div key={e.file} className="rounded-xl border border-bad/25 bg-bad/[0.05] px-4 py-3 text-ui-sm text-foreground">
                <span className="font-mono">{e.file}</span>: {e.error}. Ruah will not change it until it is fixed or deleted.
              </div>
            ))}
            {message !== null ? (
              <div role="status" className={cn("rounded-lg px-3 py-2 text-ui-sm", message.tone === "ok" ? "bg-ok/10 text-foreground" : "bg-bad/10 text-bad")}>
                {message.text}
              </div>
            ) : null}

            {tab === "installed" ? (
              data === null ? (
                x.list.status === "loading" ? <p className="text-ui-sm text-muted-foreground">Loading…</p> : null
              ) : count === 0 ? (
                <EmptyInstalled onBrowse={() => setTab("discover")} />
              ) : filtered.length === 0 ? (
                <p className="text-ui-sm text-muted-foreground">No extension matches “{query}”.</p>
              ) : (
                groups.map((g) => (
                  <section key={g.scope} className="flex flex-col gap-3">
                    <div className="flex items-baseline gap-2">
                      <h2 className="heading text-title text-foreground">{g.title}</h2>
                      <span className="text-meta text-faint">{g.hint}</span>
                    </div>
                    {g.items.map((view) => (
                      <ExtensionCard
                        key={`${view.scope}/${view.id}`}
                        view={view}
                        api={x.api}
                        installedAgents={installedAgents}
                        hasProject={data.project !== null}
                        highlight={highlight === `${view.scope}/${view.id}`}
                        onChanged={onChanged}
                        onMessage={(text, tone = "ok") => setMessage({ text, tone })}
                      />
                    ))}
                  </section>
                ))
              )
            ) : null}

            {tab === "discover" ? (
              <DiscoverView featured={x.featured} query={query} onAddFeatured={(entry) => setAdding({ featured: entry })} onAddCustom={(source) => setAdding({ featured: null, ...(source !== undefined ? { source } : {}) })} />
            ) : null}

            {tab === "agents" && !noDaemon ? <PerAgentView api={x.api} discovery={x.discovery} loadDiscovery={x.loadDiscovery} version={version} /> : null}
          </div>
        </div>

        <AddExtensionDialog
          open={adding !== null}
          onOpenChange={(open) => (open ? null : setAdding(null))}
          api={x.api}
          featured={adding?.featured ?? null}
          initialSource={adding?.source ?? "command"}
          hasProject={data?.project !== null && data?.project !== undefined}
          installedAgents={installedAgents}
          onAdded={onAdded}
        />
      </div>
    </TooltipProvider>
  );
}
