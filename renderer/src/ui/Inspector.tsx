import { useEffect, useState } from "react";
import { Copy, FileCode } from "lucide-react";
import type { ArchNode, Architecture } from "../lib/contract/index.js";
import type { CodeFile } from "../lib/graphTypes.js";
import { kindStyles } from "./kinds.js";

export type InspectorTab = "details" | "code" | "agent";

function Fact({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-[11px]" style={{ color: "var(--muted-foreground)" }}>
        {label}
      </dt>
      <dd
        className="mono truncate text-[11.5px]"
        style={{ color: accent === true ? "var(--accent)" : "var(--foreground)" }}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

interface DetailsProps {
  node: ArchNode;
  architecture: Architecture;
  copied: boolean;
  onCopyContext: () => void;
}

export function DetailsTab({ node, architecture, copied, onCopyContext }: DetailsProps) {
  const style = kindStyles[node.type as keyof typeof kindStyles] ?? kindStyles.module;
  const Icon = style.icon;
  const layer = node.layer ?? "";
  const parent = node.parent === undefined ? null : architecture.nodes.find((n) => n.id === node.parent);
  const children = architecture.nodes.filter((n) => n.parent === node.id);
  const incoming = architecture.edges.filter((e) => e.to === node.id);
  const outgoing = architecture.edges.filter((e) => e.from === node.id);

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-auto">
      <div className="px-4 py-4">
        <div className="flex items-start gap-2.5">
          <span
            className="grid size-7 shrink-0 place-items-center rounded-[4px] border"
            style={{ borderColor: "var(--hairline)", backgroundColor: "var(--surface-2)" }}
          >
            <Icon className="size-4" style={{ color: style.color }} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="mono truncate text-[13px] font-medium">{node.name}</p>
            <p className="mono text-[10.5px]" style={{ color: "var(--muted-foreground)" }}>
              {style.label}
              {layer.length > 0 ? ` · ${layer}` : ""}
            </p>
          </div>
        </div>
        {node.description !== undefined ? (
          <p className="pt-3 text-[12px] leading-relaxed">{node.description}</p>
        ) : null}
        {node.notes !== undefined && node.notes.length > 0 ? (
          <>
            <p className="pt-3 text-[9.5px] font-semibold uppercase" style={{ color: "var(--muted-foreground)" }}>
              Notes
            </p>
            <p className="whitespace-pre-wrap text-[11.5px] leading-relaxed" style={{ color: "var(--muted-foreground)" }}>
              {node.notes}
            </p>
          </>
        ) : null}
        {node.tech !== undefined && node.tech.length > 0 ? (
          <div className="flex flex-wrap gap-1 pt-3">
            {node.tech.map((t) => (
              <span
                key={t}
                className="mono rounded-sm border px-1.5 py-0.5 text-[10px]"
                style={{ borderColor: "var(--hairline)", color: "var(--muted-foreground)" }}
              >
                {t}
              </span>
            ))}
          </div>
        ) : null}
        <dl className="space-y-1.5 pt-4">
          {node.path !== undefined ? <Fact label="path" value={node.path} accent /> : null}
          {parent != null ? <Fact label="parent" value={`${parent.name} (${parent.type})`} /> : null}
          {children.length > 0 ? (
            <Fact label="children" value={children.map((c) => c.name).join(", ")} />
          ) : null}
          {incoming.length > 0 ? (
            <Fact
              label="incoming"
              value={incoming.map((e) => `${e.from}${e.label === undefined ? "" : ` [${e.label}]`}`).join(", ")}
            />
          ) : null}
          {outgoing.length > 0 ? (
            <Fact
              label="outgoing"
              value={outgoing.map((e) => `${e.to}${e.label === undefined ? "" : ` [${e.label}]`}`).join(", ")}
            />
          ) : null}
        </dl>
        <div className="flex items-center gap-2 pt-4">
          <button
            type="button"
            onClick={onCopyContext}
            className="mono flex h-6 cursor-pointer items-center gap-1 rounded-[4px] border px-2 text-[10.5px]"
            style={{ borderColor: "var(--hairline)", color: copied ? "var(--ok)" : "var(--muted-foreground)" }}
          >
            <Copy className="size-3" />
            {copied ? "copied" : "Copy context"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface CodeTabProps {
  paths: string[];
  origin: string | null;
}

export function CodeTab({ paths, origin }: CodeTabProps) {
  const [selected, setSelected] = useState(0);
  const [file, setFile] = useState<CodeFile | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");

  const path = paths[selected];
  const activePath = path ?? "";

  useEffect(() => {
    if (origin === null || activePath.length === 0) {
      setStatus("idle");
      setFile(null);
      return;
    }
    let alive = true;
    setStatus("loading");
    fetch(`${origin}/api/file?path=${encodeURIComponent(activePath)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { path?: unknown; lang?: unknown; content?: unknown };
        if (typeof body.content !== "string") throw new Error("bad body");
        if (!alive) return;
        setFile({
          path: typeof body.path === "string" ? body.path : activePath,
          lang: typeof body.lang === "string" ? body.lang : "text",
          code: body.content,
        });
        setStatus("idle");
      })
      .catch(() => {
        if (alive) setStatus("error");
      });
    return () => {
      alive = false;
    };
  }, [origin, activePath]);

  if (paths.length === 0 || origin === null) {
    return (
      <Empty
        title="No file attached to this element"
        hint="Nodes list files in architecture.json; those are readable here."
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {paths.length > 1 ? (
        <select
          value={selected}
          onChange={(e) => {
            const index = Number(e.target.value);
            if (!Number.isNaN(index)) setSelected(index);
          }}
          className="mono m-2 mr-3 h-7 rounded-[4px] border px-1.5 text-[11px]"
          style={{ backgroundColor: "var(--surface-2)", color: "var(--foreground)" }}
        >
          {paths.map((p, i) => (
            <option key={p} value={i}>
              {p}
            </option>
          ))}
        </select>
      ) : null}
      {status === "loading" ? (
        <p className="mono p-3 text-[11px]" style={{ color: "var(--muted-foreground)" }}>
          loading {activePath}…
        </p>
      ) : null}
      {status === "error" ? (
        <Empty title="File unavailable" hint={`The daemon could not serve ${activePath}.`} />
      ) : null}
      {status === "idle" && file !== null ? (
        <div className="scroll-thin min-h-0 flex-1 overflow-auto" style={{ backgroundColor: "var(--canvas)" }}>
          <div
            className="mono sticky top-0 flex items-center gap-1.5 border-b px-3 py-1.5 text-[10.5px]"
            style={{ borderColor: "var(--hairline)", backgroundColor: "var(--surface-1)" }}
          >
            <FileCode className="size-3.5" style={{ color: "var(--node-file)" }} />
            <span className="truncate">{file.path}</span>
            <span className="ml-auto shrink-0" style={{ color: "var(--muted-foreground)" }}>
              {file.lang}
            </span>
          </div>
          <pre className="mono py-2 text-[11.5px] leading-[1.55]">
            {file.code.split("\n").map((line, i) => (
              <div key={i} className="flex px-3">
                <span
                  className="w-8 shrink-0 select-none pr-3 text-right"
                  style={{ color: "var(--muted-foreground)", opacity: 0.6 }}
                >
                  {i + 1}
                </span>
                <code className="whitespace-pre" style={{ color: "var(--foreground)" }}>
                  {line}
                </code>
              </div>
            ))}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
      <p className="text-[12px]">{title}</p>
      <p className="text-[11px]" style={{ color: "var(--muted-foreground)" }}>
        {hint}
      </p>
    </div>
  );
}

export function InspectorTabs({
  tab,
  onTab,
  agentBadge,
}: {
  tab: InspectorTab;
  onTab: (tab: InspectorTab) => void;
  agentBadge: string | null;
}) {
  const tabs: { id: InspectorTab; label: string }[] = [
    { id: "details", label: "Details" },
    { id: "code", label: "Code" },
    { id: "agent", label: "Agent" },
  ];
  return (
    <div className="flex h-9 shrink-0 items-center gap-4 border-b px-4" style={{ borderColor: "var(--hairline)" }}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onTab(t.id)}
          className="relative h-9 cursor-pointer text-[11px] transition-colors"
          style={{
            color: tab === t.id ? "var(--foreground)" : "var(--muted-foreground)",
            borderBottom: tab === t.id ? "1px solid var(--accent)" : "1px solid transparent",
          }}
        >
          {t.label}
          {t.id === "agent" && agentBadge !== null ? (
            <span
              className="mono ml-1 rounded-sm px-1 text-[9px]"
              style={{ backgroundColor: "var(--accent-dim)", color: "var(--accent)" }}
            >
              {agentBadge}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
