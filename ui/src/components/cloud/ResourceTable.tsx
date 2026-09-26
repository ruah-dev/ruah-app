// Cloud resources grouped provider → region → type, one fixed-height row per line so the list
// can be windowed (only the visible rows are mounted; accounts with thousands of resources stay
// smooth without a virtualisation dependency). The Health column shows the §9 live status
// (dot + label + ready/desired replicas), falling back to the provider's raw status.
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ExternalLink, Loader2, MoreHorizontal, RefreshCw } from "lucide-react";
import type { ArchNode, CloudResource } from "@/lib/contracts";
import {
  CLOUD_TYPE_LABEL,
  CLOUD_TYPE_ORDER,
  HEALTH_LABEL,
  cloudKind,
  healthCounts,
  healthTone,
  providerLabel,
  scopeActions,
  scopeBadge,
  type ScopeResourceAction,
} from "@/lib/integrations";
import { kindStyles } from "@/components/explorer/kinds";
import { ProviderGlyph, StatusDot } from "@/components/integrations/common";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ElementPicker } from "./ElementPicker";
import { cn } from "@/lib/utils";

const ROW = 40;
const OVERSCAN = 8;
const COLS = "grid grid-cols-[minmax(0,2.2fr)_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.4fr)_3.75rem] items-center gap-3";

const SCOPE_ACTION_LABEL: Record<ScopeResourceAction, string> = {
  include: "Add to project",
  exclude: "Remove from project",
  reset: "Back to what the repo says",
};

/** §14: why a resource belongs to the project ("from .do/app.yaml", "added by you"), or that it does not. */
export function ScopeBadge({ resource: r }: { resource: CloudResource }) {
  const s = r.scope;
  if (!s) return null;
  const label = s.in ? scopeBadge(s) : s.excluded ? "removed" : s.confidence === "weak" ? "looks related" : undefined;
  if (!label) return null;
  const tone = s.confidence === "manual" ? "pill-primary" : s.in ? "pill-ok" : "bg-foreground/[0.06] text-muted-foreground";
  return (
    <span
      title={s.reasons.join("\n") || label}
      className={cn("inline-flex h-4 max-w-[10rem] min-w-0 shrink-[2] items-center truncate rounded px-1.5 text-micro font-medium max-lg:hidden", tone)}
    >
      {label}
    </span>
  );
}

function ScopeMenu({ resource, onScope }: { resource: CloudResource; onScope: (r: CloudResource, a: ScopeResourceAction) => void }) {
  const actions = scopeActions(resource);
  if (!actions.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Project scope of ${resource.name}`}
        className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <MoreHorizontal className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {actions.map((a) => (
          <DropdownMenuItem key={a} onSelect={() => onScope(resource, a)}>
            {SCOPE_ACTION_LABEL[a]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type Row =
  | { kind: "provider"; key: string; provider: string; count: number; down: number; degraded: number }
  | { kind: "region"; key: string; region: string; count: number }
  | { kind: "type"; key: string; type: string; count: number }
  | { kind: "resource"; key: string; resource: CloudResource };

export function buildRows(resources: CloudResource[]): Row[] {
  const rows: Row[] = [];
  const byProvider = groupBy(resources, (r) => r.provider);
  for (const [provider, pList] of [...byProvider].sort((a, b) => a[0].localeCompare(b[0]))) {
    const counts = healthCounts(pList);
    rows.push({ kind: "provider", key: `p:${provider}`, provider, count: pList.length, down: counts.down, degraded: counts.degraded });
    const byRegion = groupBy(pList, (r) => r.region || "global");
    for (const [region, rList] of [...byRegion].sort((a, b) => a[0].localeCompare(b[0]))) {
      rows.push({ kind: "region", key: `r:${provider}:${region}`, region, count: rList.length });
      const byType = groupBy(rList, (r) => r.type);
      const types = [...byType.keys()].sort(
        (a, b) => rank(a) - rank(b) || a.localeCompare(b),
      );
      for (const type of types) {
        const tList = byType.get(type)!;
        rows.push({ kind: "type", key: `t:${provider}:${region}:${type}`, type, count: tList.length });
        for (const r of [...tList].sort((a, b) => a.name.localeCompare(b.name)))
          rows.push({ kind: "resource", key: `x:${r.id}`, resource: r });
      }
    }
  }
  return rows;
}

function rank(type: string) {
  const i = CLOUD_TYPE_ORDER.indexOf(type as (typeof CLOUD_TYPE_ORDER)[number]);
  return i < 0 ? 99 : i;
}

function groupBy<T>(list: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const item of list) {
    const k = key(item);
    const arr = m.get(k) ?? [];
    arr.push(item);
    m.set(k, arr);
  }
  return m;
}

function Tags({ tags }: { tags: Record<string, string> | undefined }) {
  const entries = Object.entries(tags ?? {});
  if (!entries.length) return <span className="text-label text-muted-foreground/40">—</span>;
  const shown = entries.slice(0, 2);
  const all = entries.map(([k, v]) => (v ? `${k}=${v}` : k)).join("\n");
  return (
    <span className="flex min-w-0 items-center gap-1" title={all}>
      {shown.map(([k, v]) => (
        <span
          key={k}
          className="min-w-0 truncate rounded bg-foreground/[0.055] px-1.5 py-px font-mono text-caption text-muted-foreground"
        >
          {v ? `${k}:${v}` : k}
        </span>
      ))}
      {entries.length > 2 ? (
        <span className="shrink-0 text-caption text-faint">+{entries.length - 2}</span>
      ) : null}
    </span>
  );
}

/** "3/3 ready · 1 restart" minus the replica count the row already shows as "3/3". */
function healthDetailText(r: CloudResource): string | undefined {
  const detail = r.healthDetail ?? (r.health && r.status !== r.health ? r.status : undefined);
  if (!detail) return undefined;
  return r.replicas ? detail.replace(/^\d+\/\d+ (ready|running)( · )?/, "") || undefined : detail;
}

function healthTitle(r: CloudResource): string | undefined {
  const parts = [
    r.health ? HEALTH_LABEL[r.health] : undefined,
    r.healthDetail,
    r.status ? `status: ${r.status}` : undefined,
    r.observedAt ? `checked ${new Date(r.observedAt).toLocaleTimeString()}` : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join("\n") : undefined;
}

export function ResourceTable({
  resources,
  nodes,
  manualLinks,
  syncing,
  onSyncProvider,
  empty,
  selectedId,
  onSelect,
  onScope,
}: {
  resources: CloudResource[];
  nodes: ArchNode[];
  manualLinks: Record<string, true>;
  syncing: string | null;
  onSyncProvider: (provider: string) => void;
  empty: ReactNode;
  /** Resource shown in the page's details drawer. */
  selectedId?: string | null;
  onSelect?: (resourceId: string) => void;
  /** §14: the row menu's Add to / Remove from project. */
  onScope?: (resource: CloudResource, action: ScopeResourceAction) => void;
}) {
  const rows = useMemo(() => buildRows(resources), [resources]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState({ top: 0, height: 800 });

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setView({ top: el.scrollTop, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const first = Math.max(0, Math.floor(view.top / ROW) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((view.top + view.height) / ROW) + OVERSCAN);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className={cn(
          COLS,
          "h-8 shrink-0 border-b border-hairline px-5 text-meta text-muted-foreground max-md:px-3",
        )}
        role="row"
      >
        <span role="columnheader">Resource</span>
        <span role="columnheader">Health</span>
        <span role="columnheader">Tags</span>
        <span role="columnheader">Runs element</span>
        <span role="columnheader" className="sr-only">
          Console
        </span>
      </div>
      <div
        ref={scrollRef}
        onScroll={(e) => {
          // Read it now: React clears currentTarget before the updater runs.
          const top = e.currentTarget.scrollTop;
          setView((v) => ({ ...v, top }));
        }}
        className="min-h-0 flex-1 overflow-y-auto"
        role="rowgroup"
      >
        {rows.length === 0 ? (
          empty
        ) : (
          <div className="relative" style={{ height: rows.length * ROW }}>
            {rows.slice(first, last).map((row, i) => (
              <div
                key={row.key}
                className="absolute inset-x-0"
                style={{ top: (first + i) * ROW, height: ROW }}
              >
                <RowView
                  row={row}
                  nodes={nodes}
                  manualLinks={manualLinks}
                  syncing={syncing}
                  onSyncProvider={onSyncProvider}
                  selected={row.kind === "resource" && row.resource.id === selectedId}
                  {...(onSelect ? { onSelect } : {})}
                  {...(onScope ? { onScope } : {})}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RowView({
  row,
  nodes,
  manualLinks,
  syncing,
  onSyncProvider,
  selected,
  onSelect,
  onScope,
}: {
  row: Row;
  nodes: ArchNode[];
  manualLinks: Record<string, true>;
  syncing: string | null;
  onSyncProvider: (provider: string) => void;
  selected: boolean;
  onSelect?: (resourceId: string) => void;
  onScope?: (resource: CloudResource, action: ScopeResourceAction) => void;
}) {
  if (row.kind === "provider") {
    const busy = syncing === "all" || !!syncing?.startsWith(`${row.provider}:`);
    return (
      <div className="flex h-full items-end gap-2 px-5 pb-1.5 max-md:px-3">
        <ProviderGlyph id={row.provider} className="mb-px size-4" />
        <span className="text-ui font-medium text-foreground">{providerLabel(row.provider)}</span>
        <span className="text-label text-muted-foreground">{row.count}</span>
        {row.down ? <span className="text-label text-bad">· {row.down} down</span> : null}
        {row.degraded ? <span className="text-label text-warn">· {row.degraded} degraded</span> : null}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => onSyncProvider(row.provider)}
          disabled={!!syncing}
          className="flex h-6 items-center gap-1 rounded-md px-1.5 text-meta text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
          Sync {providerLabel(row.provider)}
        </button>
      </div>
    );
  }
  if (row.kind === "region") {
    return (
      <div className="flex h-full items-end gap-2 border-b border-hairline px-5 pb-1.5 ps-11 max-md:px-3">
        <span className="font-mono text-label text-foreground/80">{row.region}</span>
        <span className="text-meta text-faint">{row.count}</span>
      </div>
    );
  }
  if (row.kind === "type") {
    const style = kindStyles[cloudKind(row.type)];
    const Icon = style.icon;
    return (
      <div className="flex h-full items-center gap-2 px-5 ps-11 max-md:px-3">
        <Icon className={cn("size-3.5", style.color)} />
        <span className="text-label font-medium text-muted-foreground">
          {CLOUD_TYPE_LABEL[row.type as keyof typeof CLOUD_TYPE_LABEL] ?? row.type}
        </span>
        <span className="text-meta text-faint">{row.count}</span>
      </div>
    );
  }
  const r = row.resource;
  const style = kindStyles[cloudKind(r.type)];
  const Icon = style.icon;
  const tone = healthTone(r);
  const manual = r.linkSource === "manual" || !!manualLinks[r.id];
  const detail = healthDetailText(r);
  return (
    <div
      role="row"
      aria-selected={selected}
      className={cn(
        COLS,
        "h-full px-5 ps-11 transition-colors hover:bg-foreground/[0.025] max-md:px-3",
        selected && "bg-accent/60 hover:bg-accent/60",
      )}
    >
      <span role="cell" className="flex min-w-0 items-center gap-2.5 ps-3">
        <Icon className={cn("size-3.5 shrink-0", style.color)} />
        {onSelect ? (
          <button
            type="button"
            onClick={() => onSelect(r.id)}
            className="min-w-0 truncate text-left text-ui text-foreground hover:underline"
            title={`${r.id} — show details`}
          >
            {r.name}
          </button>
        ) : (
          <span className="min-w-0 truncate text-ui text-foreground" title={r.id}>
            {r.name}
          </span>
        )}
        <span className="shrink-0 font-mono text-caption text-faint">{r.service}</span>
        <ScopeBadge resource={r} />
      </span>
      <span
        role="cell"
        className="flex min-w-0 items-center gap-1.5 text-ui-sm text-muted-foreground"
        title={healthTitle(r)}
      >
        <StatusDot tone={tone} />
        {r.health ? (
          <>
            <span
              className={cn(
                "shrink-0",
                r.health === "down" && "text-bad",
                r.health === "degraded" && "text-warn",
                r.health === "healthy" && "text-foreground/85",
              )}
            >
              {HEALTH_LABEL[r.health]}
            </span>
            {r.replicas ? (
              <span className="shrink-0 font-mono text-caption text-faint">
                {r.replicas.ready}/{r.replicas.desired}
              </span>
            ) : null}
            {detail ? <span className="min-w-0 truncate text-label text-faint">{detail}</span> : null}
          </>
        ) : (
          <span className="truncate">{r.status ?? "—"}</span>
        )}
      </span>
      <span role="cell" className="min-w-0">
        <Tags tags={r.tags} />
      </span>
      <span role="cell" className="min-w-0">
        <ElementPicker resource={r} nodes={nodes} manual={manual} />
      </span>
      <span role="cell" className="flex justify-end">
        {onScope ? <ScopeMenu resource={r} onScope={onScope} /> : null}
        {r.consoleUrl ? (
          <a
            href={r.consoleUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${r.name} in the ${providerLabel(r.provider)} console`}
            title="Open in console"
            className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
          </a>
        ) : null}
      </span>
    </div>
  );
}
