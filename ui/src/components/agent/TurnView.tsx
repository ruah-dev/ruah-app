// Visual patterns adapted from t3code apps/web/src/components/chat/MessagesTimeline.tsx (MIT):
// user messages as subtle right-aligned bubbles, assistant output as plain text, work entries
// as quiet single lines.
import { Brain, Check, CheckCircle2, Circle, CircleDot, FileCode2, ListTree, X } from "lucide-react";
import type { PlanEntry, StreamEvent, ToolCallView } from "@/lib/contracts";
import type { PermissionRecord, Turn } from "@/lib/daemon";
import { cn } from "@/lib/utils";
import { Phantom, type PhantomExpression } from "@/components/brand/Phantom";
import { turnFailed } from "@/components/brand/agentExpression";
import { Markdown } from "./Markdown";
import { PermissionCard } from "./PermissionCard";
import { RowDisclosure, ToolCallRow } from "./ToolCallRow";
import { TurnAttachments } from "./Attachments";
import { TurnMapChanges } from "./TurnMapChanges";

type Segment =
  | { k: "text"; text: string }
  | { k: "thought"; text: string }
  | { k: "tool"; call: ToolCallView }
  | { k: "diff"; ev: Extract<StreamEvent, { kind: "diff" }> }
  | { k: "plan"; entries: PlanEntry[] }
  | { k: "perm"; rec: PermissionRecord };

/** CONTRACTS.md §2.2 rules 7–9: text chunks append to the current paragraph, a tool call closes
 * it; tool_call/tool_result upsert by toolCallId; the latest plan replaces earlier ones. */
function segmentsOf(turn: Turn): Segment[] {
  const segs: Segment[] = [];
  const toolIndex = new Map<string, number>();
  let planIndex = -1;
  const pushRecords = (at: number) => {
    for (const rec of turn.resolved) if (rec.atEvent === at) segs.push({ k: "perm", rec });
  };
  turn.events.forEach((ev, i) => {
    pushRecords(i);
    const last = segs[segs.length - 1];
    switch (ev.kind) {
      case "text":
        if (last?.k === "text") last.text += ev.text;
        else segs.push({ k: "text", text: ev.text });
        break;
      case "thought":
        if (last?.k === "thought") last.text += ev.text;
        else segs.push({ k: "thought", text: ev.text });
        break;
      case "tool_call":
      case "tool_result": {
        const at = toolIndex.get(ev.toolCall.toolCallId);
        if (at !== undefined) segs[at] = { k: "tool", call: ev.toolCall };
        else {
          toolIndex.set(ev.toolCall.toolCallId, segs.length);
          segs.push({ k: "tool", call: ev.toolCall });
        }
        break;
      }
      case "diff":
        segs.push({ k: "diff", ev });
        break;
      case "plan":
        if (planIndex >= 0) segs[planIndex] = { k: "plan", entries: ev.entries };
        else {
          planIndex = segs.length;
          segs.push({ k: "plan", entries: ev.entries });
        }
        break;
    }
  });
  for (const rec of turn.resolved)
    if (rec.atEvent >= turn.events.length) segs.push({ k: "perm", rec });
  return segs;
}

export function DiffBlock({
  ev,
  onOpenPath,
}: {
  ev: Extract<StreamEvent, { kind: "diff" }>;
  onOpenPath?: ((p: string) => void) | undefined;
}) {
  const oldLines = ev.oldText === null ? [] : ev.oldText.split("\n");
  const newLines = ev.newText.split("\n");
  return (
    <div className="overflow-hidden rounded-xl bg-surface-1 shadow-card ring-1 ring-hairline">
      <button
        type="button"
        onClick={() => onOpenPath?.(ev.path)}
        className="flex h-8 w-full items-center gap-2 px-3 text-left transition-colors hover:bg-accent"
      >
        <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-mono text-[11.5px] text-foreground/90">
          {ev.path}
        </span>
        <span className="ms-auto flex shrink-0 items-center gap-1.5 font-mono text-[11px]">
          {ev.oldText === null ? <span className="text-muted-foreground">new</span> : null}
          <span className="text-ok">+{newLines.length}</span>
          {oldLines.length ? <span className="text-bad">−{oldLines.length}</span> : null}
        </span>
      </button>
      <pre className="max-h-72 overflow-auto border-t border-hairline py-1.5 font-mono text-[11.5px] leading-[1.6]">
        {oldLines.map((l, i) => (
          <div key={`o${i}`} className="flex bg-bad/[0.07] px-3">
            <span className="w-4 shrink-0 text-bad/80 select-none">−</span>
            <code className="whitespace-pre text-foreground/75">{l}</code>
          </div>
        ))}
        {newLines.map((l, i) => (
          <div key={`n${i}`} className="flex bg-ok/[0.07] px-3">
            <span className="w-4 shrink-0 text-ok/80 select-none">+</span>
            <code className="whitespace-pre text-foreground/90">{l}</code>
          </div>
        ))}
      </pre>
    </div>
  );
}

function PlanList({ entries }: { entries: PlanEntry[] }) {
  const done = entries.filter((e) => e.status === "completed").length;
  return (
    <RowDisclosure
      icon={ListTree}
      label="Plan"
      detail={`${done}/${entries.length}`}
      defaultOpen
    >
      <ul className="space-y-1 pb-1">
        {entries.map((e, i) => {
          const Icon =
            e.status === "completed"
              ? CheckCircle2
              : e.status === "in_progress"
                ? CircleDot
                : Circle;
          return (
            <li key={i} className="flex items-start gap-2 text-[12.5px]">
              <Icon
                className={cn(
                  "mt-0.5 size-3.5 shrink-0",
                  e.status === "completed"
                    ? "text-ok"
                    : e.status === "in_progress"
                      ? "text-warn"
                      : "text-faint",
                )}
              />
              <span
                className={
                  e.status === "completed"
                    ? "text-muted-foreground line-through"
                    : "text-foreground/85"
                }
              >
                {e.content}
              </span>
            </li>
          );
        })}
      </ul>
    </RowDisclosure>
  );
}

function permissionVerb(rec: PermissionRecord) {
  if (rec.cancelled) return "Dismissed";
  if (rec.optionKind?.startsWith("reject")) return "Rejected";
  if (rec.optionKind === "allow_always") return "Always allowed";
  return "Allowed";
}

const stopLabel: Record<string, string> = {
  cancelled: "Stopped",
  max_tokens: "Stopped · output limit reached",
  max_turn_requests: "Stopped · request limit reached",
  refusal: "The agent declined",
  error: "Failed",
};

export function TurnView({
  turn,
  contextPath,
  running,
  onOpenPath,
  keyboard = true,
}: {
  turn: Turn;
  /** null = asked without an element as context. */
  contextPath: string | null;
  running: boolean;
  onOpenPath?: ((path: string) => void) | undefined;
  /** Whether this instance owns the permission-card keyboard shortcuts. */
  keyboard?: boolean;
}) {
  const segs = segmentsOf(turn);
  const lastIndex = segs.length - 1;
  const cursor = (
    <span className="ms-0.5 inline-block h-[1.05em] w-[0.5em] translate-y-[0.2em] animate-pulse rounded-[1px] bg-foreground/60" />
  );
  const showCursor = running && !turn.permission;
  // The assistant's avatar: lavender agent ghost; thinking while it streams, warning while it
  // waits on a permission, error when the turn failed.
  const face: PhantomExpression = running
    ? turn.permission
      ? "warning"
      : turn.waitingFor
        ? "loading"
        : "thinking"
    : turnFailed(turn) || turn.stopReason === "refusal"
      ? "error"
      : "agent";

  return (
    <div id={`turn-${turn.id}`} className="scroll-mt-4 space-y-3">
      {/* user */}
      <div className="flex flex-col items-end gap-1">
        <TurnAttachments attachments={turn.attachments} />
        <div className="max-w-[88%] rounded-2xl bg-message px-3.5 py-2 text-[13.5px] leading-relaxed whitespace-pre-wrap text-foreground">
          {turn.text}
        </div>
        {contextPath !== null ? (
          <span className="max-w-[88%] truncate pe-1 font-mono text-[11px] text-faint">
            @{contextPath}
          </span>
        ) : null}
      </div>

      {/* assistant */}
      <div className="flex gap-2.5">
      <Phantom
        expression={face}
        size="sm"
        noFloat
        label={running ? "Agent working" : face === "error" ? "Agent turn failed" : "Agent"}
        className="-ms-0.5 mt-0.5"
      />
      <div className="min-w-0 flex-1 space-y-2 text-[13.5px] leading-relaxed text-foreground/90">
        {turn.contextPack ? (
          <RowDisclosure icon={FileCode2} label="Context sent to the agent" tone="ai">
            <pre className="max-h-60 overflow-auto rounded-lg bg-ai/[0.06] p-2 font-mono text-[11px] leading-snug whitespace-pre-wrap text-foreground/80 ring-1 ring-ai/25">
              {turn.contextPack}
            </pre>
          </RowDisclosure>
        ) : null}
        {segs.map((s, i) => {
          switch (s.k) {
            case "text":
              return (
                <Markdown
                  key={i}
                  text={s.text}
                  onOpenPath={onOpenPath}
                  trailing={showCursor && i === lastIndex ? cursor : null}
                />
              );
            case "thought":
              return (
                <RowDisclosure key={i} icon={Brain} label="Thinking" tone="ai">
                  <p className="pb-1 text-[12.5px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
                    {s.text}
                  </p>
                </RowDisclosure>
              );
            case "tool":
              return <ToolCallRow key={i} call={s.call} onOpenPath={onOpenPath} />;
            case "diff":
              return <DiffBlock key={i} ev={s.ev} onOpenPath={onOpenPath} />;
            case "plan":
              return <PlanList key={i} entries={s.entries} />;
            case "perm": {
              const denied = s.rec.cancelled || s.rec.optionKind?.startsWith("reject");
              return (
                <p
                  key={i}
                  className={cn(
                    "flex min-w-0 items-center gap-2 text-[12px]",
                    denied ? "text-warn" : "text-muted-foreground",
                  )}
                >
                  {denied ? (
                    <X className="size-3.5 shrink-0" />
                  ) : (
                    <Check className="size-3.5 shrink-0 text-ok" />
                  )}
                  <span className="truncate">
                    {permissionVerb(s.rec)} · {s.rec.toolCall.title}
                  </span>
                </p>
              );
            }
          }
        })}
        <TurnMapChanges turn={turn} running={running} />
        {turn.permission ? (
          <PermissionCard request={turn.permission} onOpenPath={onOpenPath} keyboard={keyboard} />
        ) : null}
        {showCursor && turn.waitingFor && segs.length === 0 ? (
          <p className="flex items-center gap-2 text-[12.5px] text-muted-foreground" role="status">
            <Phantom expression="loading" size={14} />
            Waiting for {turn.waitingFor}…
          </p>
        ) : showCursor && (segs.length === 0 || segs[lastIndex]!.k !== "text") ? (
          <p className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
            <span className="size-1.5 animate-pulse rounded-full bg-ai" />
            Working…
          </p>
        ) : null}
        {turn.stopReason && turn.stopReason !== "end_turn" ? (
          <p
            className={cn(
              "text-[12px]",
              turn.stopReason === "error" || turn.stopReason === "refusal"
                ? "text-bad"
                : turn.stopReason === "cancelled"
                  ? "text-muted-foreground"
                  : "text-warn",
            )}
          >
            {stopLabel[turn.stopReason] ?? turn.stopReason}
            {turn.error ? ` · ${turn.error}` : ""}
          </p>
        ) : null}
      </div>
      </div>
    </div>
  );
}
