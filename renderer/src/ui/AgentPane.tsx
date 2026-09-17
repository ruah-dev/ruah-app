import { useEffect, useRef } from "react";
import { ShieldAlert, Square } from "lucide-react";
import type { ToolCallView } from "../lib/contract/index.js";
import type { Turn } from "../lib/store.js";
import { TOOL_STATUS_COLOR } from "./toolIcons.js";
import { TurnView } from "./TurnView.js";

interface PermissionProps {
  permission: NonNullable<Turn["permission"]>;
  busy: boolean;
  onAnswer: (requestId: string, optionId: string) => void;
  onDismiss: (requestId: string) => void;
}

// Permission card (PLAN.md L4): pinned above the composer, one button per
// option verbatim, Escape dismisses.

export function PermissionCard({ permission, busy, onAnswer, onDismiss }: PermissionProps) {
  const toolCall: ToolCallView = permission.toolCall;
  const firstAllow = permission.options.find((o) => o.kind === "allow_once" || o.kind === "allow_always");

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        onDismiss(permission.requestId);
      }
      if (e.key === "Enter" && firstAllow !== undefined) {
        e.preventDefault();
        onAnswer(permission.requestId, firstAllow.optionId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [permission.requestId, firstAllow?.optionId, onAnswer, onDismiss]);

  const statusColor = TOOL_STATUS_COLOR[toolCall.status];

  return (
    <div
      className="panel-shadow mb-2 rounded-[var(--radius)] border p-2.5"
      style={{ backgroundColor: "var(--surface-2)", borderColor: "var(--accent)" }}
    >
      <div className="mono flex items-center gap-1.5 pb-1.5 text-[9.5px] uppercase tracking-wide" style={{ color: "var(--muted-foreground)" }}>
        <ShieldAlert className="size-3.5" style={{ color: "var(--accent)" }} />
        permission needed
      </div>
      <div className="flex items-center gap-2 pb-2">
        <span className="truncate text-[11.5px]">{toolCall.title}</span>
        {toolCall.locations[0] !== undefined ? (
          <span className="mono truncate text-[10px]" style={{ color: "var(--accent)" }}>
            {toolCall.locations[0].path}
          </span>
        ) : null}
        <span className="ml-auto size-1.5 shrink-0 rounded-full" style={{ backgroundColor: statusColor }} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {permission.options.map((option) => {
          const isAllow = option.kind === "allow_once" || option.kind === "allow_always";
          return (
            <button
              key={option.optionId}
              type="button"
              disabled={busy}
              onClick={() => onAnswer(permission.requestId, option.optionId)}
              className="mono h-6 cursor-pointer rounded-[4px] border px-2 text-[10.5px] transition-colors disabled:opacity-40"
              style={
                isAllow
                  ? { backgroundColor: "var(--accent)", borderColor: "var(--accent)", color: "var(--accent-foreground)" }
                  : { backgroundColor: "transparent", borderColor: "var(--hairline)", color: "var(--foreground)" }
              }
            >
              {option.name}
            </button>
          );
        })}
        <button
          type="button"
          disabled={busy}
          onClick={() => onDismiss(permission.requestId)}
          className="mono flex h-6 cursor-pointer items-center gap-1 rounded-[4px] border px-2 text-[10.5px] transition-colors disabled:opacity-40"
          style={{ borderColor: "var(--hairline)", color: "var(--muted-foreground)" }}
          title="Dismiss (Esc) — cancels the request"
        >
          <Square className="size-2.5" />
          Dismiss
        </button>
      </div>
    </div>
  );
}

export function AgentPane({
  nodeLabel,
  turns,
  streaming,
  connected,
  draft,
  onDraft,
  onSend,
  onCancel,
  permission,
  onAnswer,
  onDismiss,
  onOpenPath,
}: {
  nodeLabel: string;
  turns: Turn[];
  streaming: boolean;
  connected: boolean;
  draft: string;
  onDraft: (value: string) => void;
  onSend: (text: string) => void;
  onCancel: () => void;
  permission: NonNullable<Turn["permission"]> | null;
  onAnswer: (requestId: string, optionId: string) => void;
  onDismiss: (requestId: string) => void;
  onOpenPath: (path: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="scroll-thin min-h-0 flex-1 overflow-auto">
        {turns.length === 0 ? (
          <p className="px-3 pt-3 text-[11.5px]" style={{ color: "var(--muted-foreground)" }}>
            Ask anything about this node. Context from the map is attached automatically.
            {connected ? "" : " (Daemon disconnected — connect to send prompts.)"}
          </p>
        ) : (
          turns.map((turn) => <TurnView key={turn.id} turn={turn} nodeLabel={nodeLabel} onOpenPath={onOpenPath} />)
        )}
      </div>
      {permission !== null ? (
        <div className="px-2.5 pt-2.5">
          <PermissionCard permission={permission} busy={streaming} onAnswer={onAnswer} onDismiss={onDismiss} />
        </div>
      ) : null}
      <Composer
        nodeLabel={nodeLabel}
        disabled={!connected || streaming}
        streaming={streaming}
        draft={draft}
        onDraft={onDraft}
        onSend={onSend}
        onCancel={onCancel}
      />
    </div>
  );
}

export function Composer({
  nodeLabel,
  disabled,
  streaming,
  draft,
  onDraft,
  onSend,
  onCancel,
}: {
  nodeLabel: string;
  disabled: boolean;
  streaming: boolean;
  draft: string;
  onDraft: (value: string) => void;
  onSend: (text: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    ref.current?.focus();
  }, [nodeLabel]);

  return (
    <div className="border-t p-2.5" style={{ borderColor: "var(--hairline)", backgroundColor: "var(--surface-1)" }}>
      <textarea
        ref={ref}
        value={draft}
        disabled={disabled}
        rows={2}
        placeholder={streaming ? "Agent is running…" : `Ask about ${nodeLabel}…`}
        onChange={(e) => onDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend(draft.trim());
          }
        }}
        className="mono scroll-thin w-full resize-none rounded-[var(--radius-sm)] border p-2 text-[11.5px] disabled:opacity-50"
        style={{ backgroundColor: "var(--surface-2)", color: "var(--foreground)" }}
      />
      <div className="flex items-center justify-between pt-1.5">
        <span className="mono truncate text-[10px]" style={{ color: "var(--accent)" }}>
          @{nodeLabel}
        </span>
        {streaming ? (
          <button
            type="button"
            onClick={onCancel}
            className="mono flex h-6 cursor-pointer items-center gap-1 rounded-[4px] border px-2 text-[11px]"
            style={{ borderColor: "var(--bad)", color: "var(--bad)" }}
          >
            <Square className="size-2.5" />
            Stop
          </button>
        ) : (
          <button
            type="button"
            disabled={disabled || draft.trim().length === 0}
            onClick={() => onSend(draft.trim())}
            className="mono h-6 cursor-pointer rounded-[4px] border px-2.5 text-[11px] disabled:opacity-40"
            style={{ backgroundColor: "var(--accent)", borderColor: "var(--accent)", color: "var(--accent-foreground)" }}
          >
            Send ⏎
          </button>
        )}
      </div>
    </div>
  );
}
