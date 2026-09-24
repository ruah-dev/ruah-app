// Cloud in the Details panel: the resources that run the selected element, and the full view
// of a resource selected on the derived Cloud level of the Map.
import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { DiagramNode } from "@/data/graphs";
import {
  CLOUD_TYPE_LABEL,
  cloudKind,
  providerLabel,
  resourceIdOf,
  resourceTone,
  useEnsure,
} from "@/lib/integrations";
import { useWorkspace } from "@/lib/workspace";
import { useWorkbench } from "@/lib/workbench";
import { kindStyles } from "@/components/explorer/kinds";
import { Pill, StatusDot, useCopy } from "@/components/integrations/common";
import { ElementPicker } from "./ElementPicker";
import { cn } from "@/lib/utils";

/** "Cloud" section of an element's Details: resources whose linkedNodeId is this element. */
export function ElementCloudSection({ node }: { node: DiagramNode }) {
  const s = useEnsure("cloud");
  if (s.cloud.status !== "ok") return null;
  const linked = s.cloud.data.resources.filter((r) => r.linkedNodeId === node.id);
  if (!linked.length) return null;
  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-1">
        <h3 className="text-[12px] font-medium text-muted-foreground">Runs on</h3>
        <span className="text-[11.5px] text-faint">{linked.length}</span>
        <span className="flex-1" />
        <Link
          to="/cloud"
          className="text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
        >
          Cloud
        </Link>
      </div>
      <ul>
        {linked.map((r) => {
          const style = kindStyles[cloudKind(r.type)];
          const Icon = style.icon;
          return (
            <li
              key={r.id}
              className="group/res -mx-1.5 flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 hover:bg-accent/60"
            >
              <Icon className={cn("size-3.5 shrink-0", style.color)} />
              <span className="min-w-0 truncate text-[12.5px] text-foreground/90" title={r.id}>
                {r.name}
              </span>
              <span className="shrink-0 font-mono text-[11px] text-faint">
                {providerLabel(r.provider)} · {r.service}
                {r.region ? ` · ${r.region}` : ""}
              </span>
              <span className="flex-1" />
              <StatusDot tone={resourceTone(r.status)} />
              {r.consoleUrl ? (
                <a
                  href={r.consoleUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Open ${r.name} in the console`}
                  className="grid size-6 place-items-center rounded text-muted-foreground opacity-0 transition-opacity group-hover/res:opacity-100 hover:text-foreground"
                >
                  <ExternalLink className="size-3.5" />
                </a>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function CopyId({ id }: { id: string }) {
  const [copied, copy] = useCopy();
  return (
    <button
      type="button"
      onClick={() => copy(id)}
      title={copied ? "Copied" : "Copy id"}
      className="max-w-full truncate text-left font-mono text-[11.5px] text-muted-foreground hover:text-foreground"
    >
      {copied ? "Copied" : id}
    </button>
  );
}

/** Details for a resource node on the Cloud level (ids are "cloud:<resource id>"). */
export function CloudResourceDetails({ node }: { node: DiagramNode }) {
  const s = useEnsure("cloud");
  const { architecture } = useWorkspace();
  const wb = useWorkbench();
  const id = resourceIdOf(node.id);
  const r = s.cloud.status === "ok" ? s.cloud.data.resources.find((x) => x.id === id) : undefined;
  const style = kindStyles[node.kind];
  const Icon = style.icon;

  if (!r) {
    return (
      <div className="px-5 pt-5 text-[12.5px] text-muted-foreground">
        This resource is no longer in the last sync.
      </div>
    );
  }
  const tone = resourceTone(r.status);
  const manual = r.linkSource === "manual" || !!s.manualLinks[r.id];
  const linked = r.linkedNodeId ? architecture.nodes.find((n) => n.id === r.linkedNodeId) : undefined;
  const tags = Object.entries(r.tags ?? {});

  const facts: [string, ReactNode][] = [
    ["Provider", providerLabel(r.provider)],
    ["Type", `${CLOUD_TYPE_LABEL[r.type] ?? r.type} · ${r.service}`],
    ["Region", r.region ?? "global"],
    [
      "Status",
      r.status ? (
        <Pill tone={tone}>{r.status}</Pill>
      ) : (
        "—"
      ),
    ],
    ...(r.url
      ? ([
          [
            "URL",
            <a href={r.url} target="_blank" rel="noreferrer" className="text-foreground/90 underline-offset-2 hover:underline" title={r.url}>
              {r.url.replace(/^https?:\/\//, "")}
            </a>,
          ],
        ] as [string, ReactNode][])
      : []),
    ["ID", <CopyId id={r.id} />],
  ];

  return (
    <div className="space-y-6 px-5 pt-5 pb-8">
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2">
          <Icon className={cn("size-4", style.color)} />
        </span>
        <div className="min-w-0 flex-1 pt-px">
          <p className="truncate text-[15px] font-medium text-foreground">{r.name}</p>
          <p className="truncate text-[12.5px] text-muted-foreground">
            {providerLabel(r.provider)} {r.service}
          </p>
        </div>
        {r.consoleUrl ? (
          <a
            href={r.consoleUrl}
            target="_blank"
            rel="noreferrer"
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ExternalLink className="size-3.5" /> Console
          </a>
        ) : null}
      </div>

      <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px]">
        {facts.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="min-w-0 truncate text-foreground/90">{v}</dd>
          </div>
        ))}
      </dl>

      <section className="space-y-1.5">
        <h3 className="text-[12px] font-medium text-muted-foreground">Runs element</h3>
        <div className="-mx-1.5 flex items-center gap-1">
          <ElementPicker resource={r} nodes={architecture.nodes} manual={manual} />
          {linked ? (
            <button
              type="button"
              onClick={() => wb.openNode(linked.id)}
              className="shrink-0 rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Open
            </button>
          ) : null}
        </div>
        {!r.linkedNodeId ? (
          <p className="text-[12px] leading-relaxed text-faint">
            Tag the resource <span className="font-mono text-foreground/80">ruah:node=&lt;element id&gt;</span> to
            link it automatically on the next sync.
          </p>
        ) : null}
      </section>

      {tags.length ? (
        <section className="space-y-1.5">
          <h3 className="text-[12px] font-medium text-muted-foreground">Tags</h3>
          <div className="flex flex-wrap gap-1">
            {tags.map(([k, v]) => (
              <span
                key={k}
                className="rounded bg-foreground/[0.055] px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
              >
                {v ? `${k}:${v}` : k}
              </span>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
