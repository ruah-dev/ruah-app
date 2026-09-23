// Visual patterns adapted from t3code apps/web/src/components/chat/ComposerSurface.tsx and
// ComposerPrimaryActions.tsx (MIT): a rounded surface, auto-growing textarea, controls in the
// bottom row, a round send / stop button on the right.
import { useEffect, useLayoutEffect, useRef, useState, forwardRef, useImperativeHandle } from "react";
import { onComposerDraft, takeComposerDraft } from "@/lib/composer-draft";
import { ArrowUp, AtSign, Square, X } from "lucide-react";
import type { DiagramNode } from "@/data/graphs";
import { kindStyles } from "@/components/explorer/kinds";
import {
  setAgent,
  setAgentMode,
  setModel,
  type DaemonState,
} from "@/lib/daemon";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { AgentModelPicker, ModePicker } from "./ComposerControls";

const MAX_HEIGHT = 220;

export type ComposerHandle = { focus: () => void };

type Props = {
  node: DiagramNode | null;
  contextPath: string;
  daemon: DaemonState;
  running: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  /** Removing the context chip clears the selection. */
  onClearContext?: (() => void) | undefined;
  /** When set and nothing is selected, show an "Add context" button. */
  onPickContext?: (() => void) | undefined;
};

/** Why the composer cannot send right now, or null. Shown quietly under the surface. */
function blockedReason(daemon: DaemonState): string | null {
  if (daemon.source === "sample")
    return "No Ruah daemon connected — run `archmap serve <repo>` and open the page it serves to chat.";
  if (daemon.source === null || daemon.connection === "connecting") return "Connecting to the daemon…";
  if (daemon.connection !== "open") return "Daemon disconnected — reconnecting…";
  if (daemon.agent?.state === "error")
    return `The agent failed to start${daemon.agent.error ? `: ${daemon.agent.error}` : "."}`;
  if (daemon.agent?.state === "stopped") return "The agent is stopped.";
  return null;
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  { node, contextPath, daemon, running, onSend, onStop, onClearContext, onPickContext },
  ref,
) {
  const [draft, setDraft] = useState("");
  const [pendingAgent, setPendingAgent] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);

  const reason = blockedReason(daemon);
  // Agent/model/mode choices need the socket, not a healthy agent: switching away from an
  // agent that failed to start must stay possible.
  const connected = daemon.source === "daemon" && daemon.connection === "open";
  const switching = daemon.agentSwitch;
  const inputDisabled = !!reason || running || !!switching;
  const canSend = !inputDisabled && !!node && draft.trim().length > 0;

  // "Draft … with the agent" elsewhere in the UI parks text for the composer (never auto-sent).
  useEffect(() => {
    const take = () => {
      const text = takeComposerDraft();
      if (text === null) return;
      setDraft(text);
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    take();
    return onComposerDraft(take);
  }, []);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [draft]);

  const submit = () => {
    if (!canSend) return;
    onSend(draft.trim());
    setDraft("");
  };

  const requestAgent = (agentId: string) => {
    if (running) setPendingAgent(agentId);
    else setAgent(agentId);
  };
  const pendingName = daemon.agent?.agents?.available.find((a) => a.id === pendingAgent)?.name;

  const placeholder = switching
    ? `Starting ${switching.name}…`
    : running
      ? "The agent is working…"
      : reason
        ? connected
          ? "The agent is not ready"
          : "Chat needs a connected daemon"
        : node
          ? `Ask about ${node.label}…`
          : onPickContext
            ? "Add an element as context to ask about it"
            : "Select an element on the diagram to ask about it";

  const kind = node ? kindStyles[node.kind] : null;
  const KindIcon = kind?.icon;

  return (
    <div className="space-y-1.5">
      <div
        className={cn(
          "composer-surface rounded-[20px] transition-shadow focus-within:shadow-[inset_0_0_0_1px_var(--color-input)]",
          reason && "opacity-80",
        )}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("button,[role=menu]")) return;
          inputRef.current?.focus();
        }}
      >
        {node ? (
          <div className="flex px-3 pt-2.5">
            <span
              className="group/chip flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-md bg-surface-3/70 ps-1.5 pe-1 text-[11.5px] text-foreground/85"
              title={contextPath}
            >
              {KindIcon ? <KindIcon className={cn("size-3 shrink-0", kind!.color)} /> : null}
              <span className="min-w-0 truncate font-mono">@{contextPath}</span>
              {onClearContext ? (
                <button
                  type="button"
                  aria-label="Remove context"
                  onClick={onClearContext}
                  className="grid size-4 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              ) : null}
            </span>
          </div>
        ) : onPickContext ? (
          <div className="flex px-3 pt-2.5">
            <button
              type="button"
              onClick={onPickContext}
              className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <AtSign className="size-3" />
              Add context
            </button>
          </div>
        ) : null}
        <textarea
          ref={inputRef}
          value={draft}
          rows={1}
          disabled={inputDisabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter inserts a newline; never while an IME is composing.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          aria-label="Message the agent"
          className="block max-h-[220px] min-h-[44px] w-full resize-none bg-transparent px-4 pt-2.5 pb-1 text-[13.5px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/60 disabled:cursor-not-allowed"
        />
        <div className="flex items-center gap-0.5 px-2 pb-2">
          <AgentModelPicker
            agents={connected ? daemon.agent?.agents : undefined}
            models={connected ? daemon.agent?.models : undefined}
            switching={switching}
            disabled={!connected || running}
            onModel={(id) => setModel(id)}
            onAgent={requestAgent}
          />
          <ModePicker
            modes={connected && !switching ? daemon.agent?.modes : undefined}
            disabled={!!reason || running}
            onMode={setAgentMode}
          />
          <span className="flex-1" />
          {running ? (
            <button
              type="button"
              aria-label="Stop"
              title="Stop"
              onClick={onStop}
              className="grid size-8 shrink-0 place-items-center rounded-full bg-foreground text-background transition-transform hover:scale-105"
            >
              <Square className="size-3 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              aria-label="Send message"
              title={node ? "Send (Enter)" : "Select an element first"}
              disabled={!canSend}
              onClick={submit}
              className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-all hover:scale-105 hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-30"
            >
              <ArrowUp className="size-4" strokeWidth={2.25} />
            </button>
          )}
        </div>
      </div>
      {reason ? (
        <p className="px-3 text-center text-[11.5px] text-muted-foreground/80">{reason}</p>
      ) : null}

      <AlertDialog open={pendingAgent !== null} onOpenChange={(o) => !o && setPendingAgent(null)}>
        <AlertDialogContent className="max-w-sm rounded-xl border-hairline bg-popover p-5">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[15px]">
              Switch to {pendingName ?? "another agent"}?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-[13px]">
              This stops the current turn and starts a new session.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-8 rounded-lg border-hairline bg-transparent text-[13px]">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-8 rounded-lg text-[13px]"
              onClick={() => {
                if (pendingAgent) setAgent(pendingAgent);
                setPendingAgent(null);
              }}
            >
              Switch agent
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
});
