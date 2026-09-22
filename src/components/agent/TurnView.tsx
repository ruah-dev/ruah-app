import { Bot, CheckCircle2, Circle, CircleDot, FileCode2, User } from "lucide-react";
import type { PlanEntry, StreamEvent, ToolCallView } from "@/lib/contracts";
import type { PermissionRecord, Turn } from "@/lib/daemon";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Disclosure, ToolCallRow } from "./ToolCallRow";

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

function DiffBlock({
  ev,
  onOpenPath,
}: {
  ev: Extract<StreamEvent, { kind: "diff" }>;
  onOpenPath?: ((p: string) => void) | undefined;
}) {
  const oldLines = ev.oldText === null ? [] : ev.oldText.split("\n");
  const newLines = ev.newText.split("\n");
  return (
    <div className="overflow-hidden rounded-[4px] border border-hairline">
      <button
        type="button"
        onClick={() => onOpenPath?.(ev.path)}
        className="flex h-7 w-full items-center gap-2 border-b border-hairline bg-surface-2 px-2 text-left"
      >
        <FileCode2 className="size-3.5 shrink-0 text-node-file" />
        <span className="truncate font-mono text-[10.5px] text-foreground">{ev.path}</span>
        {ev.oldText === null ? (
          <span className="ml-auto font-mono text-[9.5px] text-ok">new file</span>
        ) : null}
      </button>
      <pre className="max-h-64 overflow-auto bg-canvas py-1 font-mono text-[10.5px] leading-[1.55]">
        {oldLines.map((l, i) => (
          <div key={`o${i}`} className="flex bg-bad/10 px-2">
            <span className="w-4 shrink-0 text-bad select-none">-</span>
            <code className="whitespace-pre text-foreground/85">{l}</code>
          </div>
        ))}
        {newLines.map((l, i) => (
          <div key={`n${i}`} className="flex bg-ok/10 px-2">
            <span className="w-4 shrink-0 text-ok select-none">+</span>
            <code className="whitespace-pre text-foreground/85">{l}</code>
          </div>
        ))}
      </pre>
    </div>
  );
}

function PlanList({ entries }: { entries: PlanEntry[] }) {
  return (
    <ul className="space-y-1 rounded-[4px] border border-hairline bg-surface-2/60 px-2 py-1.5">
      {entries.map((e, i) => {
        const Icon =
          e.status === "completed" ? CheckCircle2 : e.status === "in_progress" ? CircleDot : Circle;
        return (
          <li key={i} className="flex items-start gap-1.5 text-[11.5px]">
            <Icon
              className={cn(
                "mt-0.5 size-3 shrink-0",
                e.status === "completed"
                  ? "text-ok"
                  : e.status === "in_progress"
                    ? "text-warn"
                    : "text-muted-foreground",
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
  );
}

function permissionLine(rec: PermissionRecord) {
  const verb = rec.cancelled
    ? "dismissed"
    : rec.optionKind?.startsWith("reject")
      ? "rejected"
      : rec.optionKind === "allow_always"
        ? "always allowed"
        : "allowed";
  return `${verb}: ${rec.toolCall.title}`;
}

const stopTone: Record<string, string> = {
  end_turn: "text-muted-foreground",
  cancelled: "text-warn",
  max_tokens: "text-warn",
  max_turn_requests: "text-warn",
  refusal: "text-bad",
  error: "text-bad",
};

export function TurnView({
  turn,
  contextPath,
  running,
  onOpenPath,
}: {
  turn: Turn;
  contextPath: string;
  running: boolean;
  onOpenPath?: ((path: string) => void) | undefined;
}) {
  const segs = segmentsOf(turn);
  const lastText = segs.map((s) => s.k).lastIndexOf("text");
  const cursor = (
    <span className="ml-px inline-block h-3.5 w-[1ch] translate-y-0.5 animate-pulse bg-primary/70" />
  );

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <User className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <Badge
            variant="outline"
            className="mb-1 h-4 max-w-full truncate rounded-sm border-primary/40 bg-primary/10 px-1 font-mono text-[9.5px] text-primary"
          >
            @{contextPath}
          </Badge>
          <p className="text-[12px] leading-relaxed whitespace-pre-wrap text-foreground">
            {turn.text}
          </p>
          {turn.contextPack ? (
            <Disclosure label="context">
              <pre className="mt-1 max-h-60 overflow-auto rounded-[4px] bg-surface-2 p-2 font-mono text-[10.5px] leading-snug whitespace-pre-wrap text-foreground/75">
                {turn.contextPack}
              </pre>
            </Disclosure>
          ) : null}
        </div>
      </div>

      <div className="flex gap-2">
        <Bot className="mt-0.5 size-3.5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1 space-y-1.5">
          {segs.map((s, i) => {
            switch (s.k) {
              case "text":
                return (
                  <p
                    key={i}
                    className="text-[12px] leading-relaxed whitespace-pre-wrap text-foreground/80"
                  >
                    {s.text}
                    {running && i === lastText && i === segs.length - 1 ? cursor : null}
                  </p>
                );
              case "thought":
                return (
                  <Disclosure key={i} label="thinking">
                    <p className="mt-0.5 text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground italic">
                      {s.text}
                    </p>
                  </Disclosure>
                );
              case "tool":
                return <ToolCallRow key={i} call={s.call} onOpenPath={onOpenPath} />;
              case "diff":
                return <DiffBlock key={i} ev={s.ev} onOpenPath={onOpenPath} />;
              case "plan":
                return <PlanList key={i} entries={s.entries} />;
              case "perm":
                return (
                  <p
                    key={i}
                    className={cn(
                      "font-mono text-[10.5px]",
                      s.rec.cancelled || s.rec.optionKind?.startsWith("reject")
                        ? "text-warn"
                        : "text-muted-foreground",
                    )}
                  >
                    {permissionLine(s.rec)}
                  </p>
                );
            }
          })}
          {running && (segs.length === 0 || segs[segs.length - 1]!.k !== "text") ? (
            <p>{cursor}</p>
          ) : null}
          {turn.stopReason ? (
            <p
              className={cn(
                "font-mono text-[10px]",
                stopTone[turn.stopReason] ?? "text-muted-foreground",
              )}
            >
              {turn.stopReason}
              {turn.error ? ` · ${turn.error}` : ""}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
