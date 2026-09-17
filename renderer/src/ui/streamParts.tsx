import { useState } from "react";
import { Brain, ChevronRight, FileDiff, ListChecks } from "lucide-react";
import type { StreamEvent, ToolCallView } from "../lib/contract/index.js";
import { toolIcon, TOOL_STATUS_COLOR } from "./toolIcons.js";

// Tool rows upserted by toolCallId (§2.2 rule 8); diffs rendered separately
// (§2.2 rule 9). Text chunks append to the current segment (§2.2 rule 7) —
// handled by the caller that segments events.

export interface ToolRowData {
  toolCall: ToolCallView;
  onOpenPath?: (path: string) => void;
}

export function ToolRow({ toolCall, onOpenPath }: { toolCall: ToolCallView; onOpenPath?: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(toolCall.kind);
  const statusColor = TOOL_STATUS_COLOR[toolCall.status];
  const location = toolCall.locations[0];

  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 py-0.5">
        <Icon className="size-3.5 shrink-0" style={{ color: "var(--node-file)" }} />
        <span className="truncate text-[11.5px] text-[var(--foreground)]">{toolCall.title}</span>
        {location !== undefined ? (
          <button
            type="button"
            className="mono shrink-0 cursor-pointer text-[10px] hover:underline"
            style={{ color: "var(--accent)" }}
            onClick={() => onOpenPath?.(location.path)}
          >
            {location.path}
            {location.line !== undefined ? `:${location.line}` : ""}
          </button>
        ) : null}
        <span
          className="ml-auto size-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: statusColor }}
          title={toolCall.status}
        />
        {toolCall.output !== undefined ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="mono shrink-0 cursor-pointer text-[10px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          >
            output
            <ChevronRight
              className="inline size-3 transition-transform"
              style={{ transform: open ? "rotate(90deg)" : undefined }}
            />
          </button>
        ) : null}
      </div>
      {open && toolCall.output !== undefined ? (
        <pre
          className="mono scroll-thin mb-1 max-h-40 overflow-auto rounded-[var(--radius-sm)] p-2 text-[10.5px] leading-relaxed"
          style={{ backgroundColor: "var(--surface-2)", color: "var(--muted-foreground)" }}
        >
          {toolCall.output}
        </pre>
      ) : null}
    </div>
  );
}

export function DiffBlock({
  path,
  oldText,
  newText,
}: {
  path: string;
  oldText: string | null;
  newText: string;
}) {
  return (
    <div className="mb-1 overflow-hidden rounded-[var(--radius-sm)] border" style={{ borderColor: "var(--hairline)" }}>
      <div
        className="mono flex items-center gap-1.5 border-b px-2 py-1 text-[10.5px]"
        style={{ backgroundColor: "var(--surface-2)", color: "var(--muted-foreground)" }}
      >
        <FileDiff className="size-3" style={{ color: "var(--accent)" }} />
        {path}
      </div>
      <div className="mono text-[10.5px] leading-[1.55]">
        {oldText !== null
          ? oldText.split("\n").map((line, i) => (
              <div key={`o${i}`} className="flex px-2" style={{ backgroundColor: "oklch(0.68 0.19 25 / 0.12)" }}>
                <span className="w-4 shrink-0 select-none" style={{ color: "var(--bad)" }}>
                  -
                </span>
                <span className="whitespace-pre-wrap break-all" style={{ color: "var(--foreground)" }}>
                  {line}
                </span>
              </div>
            ))
          : null}
        {newText.split("\n").map((line, i) => (
          <div key={`n${i}`} className="flex px-2" style={{ backgroundColor: "oklch(0.78 0.14 152 / 0.08)" }}>
            <span className="w-4 shrink-0 select-none" style={{ color: "var(--ok)" }}>
              +
            </span>
            <span className="whitespace-pre-wrap break-all" style={{ color: "var(--foreground)" }}>
              {line}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ThoughtBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="py-0.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="mono flex cursor-pointer items-center gap-1 text-[10px] italic"
        style={{ color: "var(--muted-foreground)" }}
      >
        <Brain className="size-3" />
        thinking
        <ChevronRight
          className="size-3 transition-transform"
          style={{ transform: open ? "rotate(90deg)" : undefined }}
        />
      </button>
      {open ? (
        <p
          className="mt-0.5 text-[11px] italic leading-relaxed"
          style={{ color: "var(--muted-foreground)" }}
        >
          {text}
        </p>
      ) : null}
    </div>
  );
}

export function PlanBlock({ entries }: { entries: Extract<StreamEvent, { kind: "plan" }>["entries"] }) {
  return (
    <div className="mb-1 rounded-[var(--radius-sm)] border p-2" style={{ borderColor: "var(--hairline)" }}>
      <div className="mono flex items-center gap-1.5 pb-1 text-[9.5px] uppercase tracking-wide" style={{ color: "var(--muted-foreground)" }}>
        <ListChecks className="size-3" />
        plan
      </div>
      <ul className="space-y-0.5">
        {entries.map((entry, i) => (
          <li key={i} className="flex items-center gap-2 text-[11.5px]">
            <span
              className="size-1.5 shrink-0 rounded-full"
              style={{
                backgroundColor:
                  entry.status === "completed"
                    ? "var(--ok)"
                    : entry.status === "in_progress"
                      ? "var(--warn)"
                      : "var(--muted-foreground)",
              }}
            />
            <span style={{ color: entry.status === "completed" ? "var(--muted-foreground)" : "var(--foreground)" }}>
              {entry.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
