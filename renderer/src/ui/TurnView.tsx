import { useMemo } from "react";
import type { StreamEvent } from "../lib/contract/index.js";
import type { Turn } from "../lib/store.js";
import { DiffBlock, PlanBlock, ThoughtBlock, ToolRow } from "./streamParts.js";

// Renders a turn per PLAN.md L3: user bubble + context disclosure, then the
// event stream — text chunks appended into segments (a tool_call opens a new
// paragraph, §2.2 rule 7), tool rows upserted by toolCallId, diffs, thoughts,
// plans, footer stopReason.

type Segment =
  | { type: "text"; text: string }
  | { type: "thought"; text: string }
  | { type: "tool"; toolCall: Extract<StreamEvent, { kind: "tool_call" | "tool_result" }>["toolCall"] }
  | { type: "diff"; path: string; oldText: string | null; newText: string }
  | { type: "plan"; entries: Extract<StreamEvent, { kind: "plan" }>["entries"] };

function segment(events: StreamEvent[]): Segment[] {
  const segments: Segment[] = [];
  let textBuffer = "";
  const flush = (): void => {
    if (textBuffer.length > 0) {
      segments.push({ type: "text", text: textBuffer });
      textBuffer = "";
    }
  };
  for (const event of events) {
    switch (event.kind) {
      case "text": {
        textBuffer += event.text;
        break;
      }
      case "thought": {
        flush();
        segments.push({ type: "thought", text: event.text });
        break;
      }
      case "tool_call":
      case "tool_result": {
        flush();
        segments.push({ type: "tool", toolCall: event.toolCall });
        break;
      }
      case "diff": {
        flush();
        segments.push({ type: "diff", path: event.path, oldText: event.oldText, newText: event.newText });
        break;
      }
      case "plan": {
        flush();
        segments.push({ type: "plan", entries: event.entries });
        break;
      }
    }
  }
  flush();
  return segments;
}

const STOP_TONE: Record<string, string> = {
  end_turn: "var(--muted-foreground)",
  cancelled: "var(--warn)",
  error: "var(--bad)",
  refusal: "var(--bad)",
  max_tokens: "var(--warn)",
  max_turn_requests: "var(--warn)",
};

export function TurnView({
  turn,
  nodeLabel,
  onOpenPath,
}: {
  turn: Turn;
  nodeLabel: string;
  onOpenPath?: (path: string) => void;
}) {
  const segments = useMemo(() => segment(turn.events), [turn.events]);
  const streaming = turn.stopReason === undefined;

  return (
    <div className="border-b px-3 py-3" style={{ borderColor: "var(--hairline)" }}>
      <div className="flex items-baseline gap-2 pb-1">
        <span className="mono text-[10px]" style={{ color: "var(--accent)" }}>
          @{nodeLabel}
        </span>
        <span className="mono truncate text-[10px]" style={{ color: "var(--muted-foreground)" }}>
          {turn.text}
        </span>
      </div>

      <details className="pb-1">
        <summary
          className="mono cursor-pointer text-[10px] select-none"
          style={{ color: "var(--muted-foreground)" }}
        >
          context ▸
        </summary>
        <pre
          className="mono scroll-thin mt-1 max-h-48 overflow-auto rounded-[var(--radius-sm)] p-2 text-[10px] leading-relaxed"
          style={{ backgroundColor: "var(--surface-2)", color: "var(--muted-foreground)" }}
        >
          {turn.contextPack}
        </pre>
      </details>

      <div className="space-y-0.5">
        {segments.map((segment, i) => {
          switch (segment.type) {
            case "text":
              return (
                <p key={i} className="text-[12px] leading-relaxed whitespace-pre-wrap" style={{ color: "var(--foreground)" }}>
                  {segment.text}
                  {streaming && i === segments.length - 1 ? <span className="stream-cursor" /> : null}
                </p>
              );
            case "thought":
              return <ThoughtBlock key={i} text={segment.text} />;
            case "tool":
              return <ToolRow key={i} toolCall={segment.toolCall} onOpenPath={onOpenPath} />;
            case "diff":
              return <DiffBlock key={i} path={segment.path} oldText={segment.oldText} newText={segment.newText} />;
            case "plan":
              return <PlanBlock key={i} entries={segment.entries} />;
          }
        })}
        {streaming && segments.length === 0 ? <span className="stream-cursor" /> : null}
      </div>

      {turn.permissionRecord !== null ? (
        <p className="mono pt-1 text-[10px]" style={{ color: "var(--muted-foreground)" }}>
          {turn.permissionRecord}
        </p>
      ) : null}

      {turn.stopReason !== undefined ? (
        <p className="mono pt-1.5 text-[10px]" style={{ color: STOP_TONE[turn.stopReason] ?? "var(--muted-foreground)" }}>
          {turn.error !== undefined ? `${turn.stopReason} — ${turn.error}` : turn.stopReason}
        </p>
      ) : null}
    </div>
  );
}
