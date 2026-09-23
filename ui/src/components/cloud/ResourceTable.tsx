// Cloud resources grouped provider → region → type, one fixed-height row per line so the list
// can be windowed (only the visible rows are mounted; accounts with thousands of resources stay
// smooth without a virtualisation dependency).
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import type { ArchNode, CloudResource } from "@/lib/contracts";
import {
  CLOUD_TYPE_LABEL,
  CLOUD_TYPE_ORDER,
  cloudKind,
  providerLabel,
  resourceTone,
} from "@/lib/integrations";
import { kindStyles } from "@/components/explorer/kinds";
import { ProviderGlyph, StatusDot } from "@/components/integrations/common";
import { ElementPicker } from "./ElementPicker";
import { cn } from "@/lib/utils";

const ROW = 40;
const OVERSCAN = 8;
const COLS = "grid grid-cols-[minmax(0,2.2fr)_minmax(0,0.9fr)_minmax(0,1.3fr)_minmax(0,1.5fr)_2rem] items-center gap-3";

type Row =
  | { kind: "provider"; key: string; provider: string; count: number }
  | { kind: "region"; key: string; region: string; count: number }
  | { kind: "type"; key: string; type: string; count: number }
  | { kind: "resource"; key: string; resource: CloudResource };

export function buildRows(resources: CloudResource[]): Row[] {
  const rows: Row[] = [];
  const byProvider = groupBy(resources, (r) => r.provider);
  for (const [provider, pList] of [...byProvider].sort((a, b) => a[0].localeCompare(b[0]))) {
    rows.push({ kind: "provider", key: `p:${provider}`, provider, count: pList.length });
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
  if (!entries.length) return <span className="text-[12px] text-muted-foreground/40">—</span>;
  const shown = entries.slice(0, 2);
  const all = entries.map(([k, v]) => (v ? `${k}=${v}` : k)).join("\n");
  return (
    <span className="flex min-w-0 items-center gap-1" title={all}>
      {shown.map(([k, v]) => (
        <span
          key={k}
          className="min-w-0 truncate rounded bg-foreground/[0.055] px-1.5 py-px font-mono text-[11px] text-muted-foreground"
        >
          {v ? `${k}:${v}` : k}
        </span>
      ))}
      {entries.length > 2 ? (
        <span className="shrink-0 text-[11px] text-faint">+{entries.length - 2}</span>
      ) : null}
    </span>
  );
}

export function ResourceTable({
  resources,
  nodes,
  manualLinks,
  syncing,
  onSyncProvider,
  empty,
}: {
  resources: CloudResource[];
  nodes: ArchNode[];
  manualLinks: Record<string, true>;
  syncing: string | null;
  onSyncProvider: (provider: string) => void;
  empty: ReactNode;
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
          "h-8 shrink-0 border-b border-hairline px-5 text-[11.5px] text-muted-foreground max-md:px-3",
        )}
        role="row"
      >
        <span role="columnheader">Resource</span>
        <span role="columnheader">Status</span>
        <span role="columnheader">Tags</span>
        <span role="columnheader">Runs element</span>
        <span role="columnheader" className="sr-only">
          Console
        </span>
      </div>
      <div
        ref={scrollRef}
        onScroll={(e) => setView((v) => ({ ...v, top: e.currentTarget.scrollTop }))}
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
}: {
  row: Row;
  nodes: ArchNode[];
  manualLinks: Record<string, true>;
  syncing: string | null;
  onSyncProvider: (provider: string) => void;
}) {
  if (row.kind === "provider") {
    const busy = syncing === "all" || !!syncing?.startsWith(`${row.provider}:`);
    return (
      <div className="flex h-full items-end gap-2 px-5 pb-1.5 max-md:px-3">
        <ProviderGlyph id={row.provider} className="mb-px size-4" />
        <span className="text-[13px] font-medium text-foreground">{providerLabel(row.provider)}</span>
        <span className="text-[12px] text-muted-foreground">{row.count}</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => onSyncProvider(row.provider)}
          disabled={!!syncing}
          className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
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
        <span className="font-mono text-[12px] text-foreground/80">{row.region}</span>
        <span className="text-[11.5px] text-faint">{row.count}</span>
      </div>
    );
  }
  if (row.kind === "type") {
    const style = kindStyles[cloudKind(row.type)];
    const Icon = style.icon;
    return (
      <div className="flex h-full items-center gap-2 px-5 ps-11 max-md:px-3">
        <Icon className={cn("size-3.5", style.color)} />
        <span className="text-[12px] font-medium text-muted-foreground">
          {CLOUD_TYPE_LABEL[row.type as keyof typeof CLOUD_TYPE_LABEL] ?? row.type}
        </span>
        <span className="text-[11.5px] text-faint">{row.count}</span>
      </div>
    );
  }
  const r = row.resource;
  const style = kindStyles[cloudKind(r.type)];
  const Icon = style.icon;
  const tone = resourceTone(r.status);
  const manual = r.linkSource === "manual" || !!manualLinks[r.id];
  return (
    <div
      role="row"
      className={cn(COLS, "h-full px-5 ps-11 transition-colors hover:bg-foreground/[0.025] max-md:px-3")}
    >
      <span role="cell" className="flex min-w-0 items-center gap-2.5 ps-3">
        <Icon className={cn("size-3.5 shrink-0", style.color)} />
        <span className="min-w-0 truncate text-[13px] text-foreground" title={r.id}>
          {r.name}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-faint">{r.service}</span>
      </span>
      <span role="cell" className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground">
        <StatusDot tone={tone} />
        <span className="truncate">{r.status ?? "—"}</span>
      </span>
      <span role="cell" className="min-w-0">
        <Tags tags={r.tags} />
      </span>
      <span role="cell" className="min-w-0">
        <ElementPicker resource={r} nodes={nodes} manual={manual} />
      </span>
      <span role="cell" className="flex justify-end">
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
