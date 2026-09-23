// Cloud: what is deployed (DigitalOcean, AWS via their CLIs), grouped provider → region → type,
// with a link from each resource to the architecture element it runs. "Show on map" adds a
// derived, read-only Cloud level to the Map.
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Cloud, Loader2, Map as MapIcon, RefreshCw, Search } from "lucide-react";
import type { CloudResource, IntegrationInfo } from "@/lib/contracts";
import {
  CLOUD_DIAGRAM_ID,
  loadCloud,
  providerLabel,
  setShowCloudOnMap,
  syncCloud,
  timeAgo,
  useLoad,
} from "@/lib/integrations";
import { useWorkspace } from "@/lib/workspace";
import { useWorkbench } from "@/lib/workbench";
import { PageHeader } from "@/components/shell/AppShell";
import { Segmented } from "@/components/map/MapPage";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import {
  IntegrationsLink,
  Notice,
  ProviderGlyph,
  RemoteNotice,
  primaryButton,
  quietButton,
} from "@/components/integrations/common";
import { ResourceTable } from "./ResourceTable";
import { cn } from "@/lib/utils";

function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function SyncMenu({
  providers,
  syncing,
  onSync,
}: {
  providers: IntegrationInfo[];
  syncing: string | null;
  onSync: (opts: { provider?: string; account?: string }) => void;
}) {
  const disabled = !!syncing || providers.length === 0;
  return (
    <div className="flex items-center">
      <button
        type="button"
        className={cn(primaryButton, "rounded-e-none")}
        disabled={disabled}
        onClick={() => onSync({})}
      >
        {syncing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
        {syncing ? "Syncing…" : "Sync"}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={disabled}
          aria-label="Sync one provider or account"
          className={cn(primaryButton, "rounded-s-none border-s border-primary-foreground/20 px-1.5")}
        >
          <ChevronDown className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem onSelect={() => onSync({})}>
            <RefreshCw className="text-muted-foreground" /> Sync all providers
          </DropdownMenuItem>
          {providers.map((p) => (
            <div key={p.id}>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[11.5px] font-normal text-muted-foreground">
                {p.name}
              </DropdownMenuLabel>
              {p.accounts?.length ? (
                p.accounts.map((a) => (
                  <DropdownMenuItem key={a.id} onSelect={() => onSync({ provider: p.id, account: a.id })}>
                    <ProviderGlyph id={p.id} />
                    <span className="truncate">{a.label}</span>
                  </DropdownMenuItem>
                ))
              ) : (
                <DropdownMenuItem onSelect={() => onSync({ provider: p.id })}>
                  <ProviderGlyph id={p.id} /> Sync {p.name}
                </DropdownMenuItem>
              )}
            </div>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function matches(r: CloudResource, q: string, nodeName: string | undefined) {
  if (!q) return true;
  const hay = [
    r.name,
    r.service,
    r.type,
    r.region ?? "",
    r.status ?? "",
    r.id,
    nodeName ?? "",
    ...Object.entries(r.tags ?? {}).map(([k, v]) => `${k}:${v}`),
  ]
    .join(" ")
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((t) => hay.includes(t));
}

export function CloudPage() {
  const s = useLoad("cloud");
  useLoad("integrations");
  const { architecture } = useWorkspace();
  const wb = useWorkbench();
  const now = useNow();
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<string>("all");
  const [linkFilter, setLinkFilter] = useState<"all" | "linked" | "unlinked">("all");
  const [syncError, setSyncError] = useState<string | null>(null);

  const cloudProviders = useMemo(
    () =>
      s.integrations.status === "ok"
        ? s.integrations.data.filter((i) => i.family === "cloud" && i.status === "connected")
        : [],
    [s.integrations],
  );
  const snapshot = s.cloud.status === "ok" ? s.cloud.data : null;
  const all = snapshot?.resources ?? [];
  const names = useMemo(() => new Map(architecture.nodes.map((n) => [n.id, n.name])), [architecture]);
  const providersInData = useMemo(() => [...new Set(all.map((r) => r.provider))].sort(), [all]);

  const visible = useMemo(
    () =>
      all.filter(
        (r) =>
          (provider === "all" || r.provider === provider) &&
          (linkFilter === "all" || (linkFilter === "linked") === !!r.linkedNodeId) &&
          matches(r, query.trim(), r.linkedNodeId ? names.get(r.linkedNodeId) : undefined),
      ),
    [all, provider, linkFilter, query, names],
  );
  const linkedCount = all.filter((r) => r.linkedNodeId).length;
  const regions = new Set(all.map((r) => `${r.provider}:${r.region ?? "global"}`)).size;

  const sync = async (opts: { provider?: string; account?: string }) => {
    setSyncError(null);
    const res = await syncCloud(opts);
    if (!res.ok) setSyncError(res.message);
  };

  const noProviders =
    s.integrations.status === "ok" && cloudProviders.length === 0 && all.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Cloud">
        <span className="text-[12px] text-muted-foreground max-sm:hidden">
          {s.syncing
            ? "Syncing…"
            : snapshot?.syncedAt
              ? `Synced ${timeAgo(snapshot.syncedAt, now)}`
              : "Never synced"}
        </span>
        <label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
          <Switch
            checked={s.showCloudOnMap}
            onCheckedChange={setShowCloudOnMap}
            aria-label="Show on map"
            className="scale-90"
          />
          Show on map
        </label>
        {s.showCloudOnMap ? (
          <button type="button" className={quietButton} onClick={() => wb.openDiagram(CLOUD_DIAGRAM_ID)}>
            <MapIcon className="size-3.5" /> Open
          </button>
        ) : null}
        <SyncMenu providers={cloudProviders} syncing={s.syncing} onSync={(o) => void sync(o)} />
      </PageHeader>

      <div className="flex shrink-0 flex-col gap-3 px-5 pt-4 pb-3 max-md:px-3">
        <RemoteNotice remote={s.cloud} what="Cloud" />
        {noProviders ? (
          <Notice
            tone="idle"
            title="No cloud provider connected"
            body={
              <>
                Connect DigitalOcean or AWS in <IntegrationsLink />. Ruah uses the provider CLI's own
                login and only reads.
              </>
            }
          />
        ) : null}
        {syncError ? <Notice tone="bad" title="Sync failed" body={syncError} /> : null}
        {snapshot?.errors.map((e) => (
          <Notice
            key={e.provider}
            tone="warn"
            title={`${providerLabel(e.provider)} could not be read`}
            body={e.message}
          />
        ))}

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex h-7 w-64 items-center gap-2 rounded-md bg-foreground/[0.045] px-2 max-sm:w-full">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by name, region, tag, element…"
              aria-label="Filter resources"
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-faint"
            />
          </div>
          {providersInData.length > 1 ? (
            <Segmented
              value={provider}
              onChange={setProvider}
              options={[
                { value: "all", label: "All" },
                ...providersInData.map((p) => ({ value: p, label: providerLabel(p) })),
              ]}
            />
          ) : null}
          <Segmented
            value={linkFilter}
            onChange={setLinkFilter}
            options={[
              { value: "all", label: "All" },
              { value: "linked", label: "Linked" },
              { value: "unlinked", label: "Unlinked" },
            ]}
          />
          <span className="flex-1" />
          {all.length ? (
            <span className="text-[12px] text-muted-foreground">
              {all.length} resources · {regions} {regions === 1 ? "region" : "regions"} · {linkedCount}{" "}
              linked
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col border-t border-hairline">
        <ResourceTable
          resources={visible}
          nodes={architecture.nodes}
          manualLinks={s.manualLinks}
          syncing={s.syncing}
          onSyncProvider={(p) => void sync({ provider: p })}
          empty={
            <div className="flex h-full min-h-60 flex-col items-center justify-center gap-2 px-8 text-center">
              {s.cloud.status === "loading" ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : (
                <>
                  <Cloud className="size-5 text-faint" />
                  <p className="heading text-[16px] text-foreground">
                    {all.length ? "Nothing matches the filter" : "No resources yet"}
                  </p>
                  <p className="max-w-sm text-[12.5px] leading-relaxed text-muted-foreground">
                    {all.length
                      ? "Clear the filter to see every resource."
                      : cloudProviders.length
                        ? "Press Sync to read what's deployed. Resources tagged ruah:node=<element id> link themselves."
                        : "Connect a cloud provider first."}
                  </p>
                  {all.length === 0 && s.cloud.status === "error" ? (
                    <button type="button" className={quietButton} onClick={() => void loadCloud()}>
                      Retry
                    </button>
                  ) : null}
                </>
              )}
            </div>
          }
        />
      </div>
    </div>
  );
}
