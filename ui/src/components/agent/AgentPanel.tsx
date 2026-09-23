// Visual patterns adapted from t3code apps/web/src/components/ChatView / chat/MessagesTimeline.tsx
// (MIT): a centered, readable message column with the composer docked at the bottom.
import { useEffect, useMemo, useRef } from "react";
import { MessageSquarePlus, RotateCcw } from "lucide-react";
import { Phantom } from "@/components/brand/RuahLogo";
import type { DiagramNode } from "@/data/graphs";
import type { Architecture } from "@/lib/contracts";
import { contextPathOf } from "@/lib/architecture";
import { cancel, resetSession, sendPrompt, type DaemonState } from "@/lib/daemon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Composer, type ComposerHandle } from "./Composer";
import { TurnView } from "./TurnView";

const suggestions = [
  "Explain what this does",
  "Where are the API requests handled?",
  "What breaks if this fails?",
];

export function agentDotClass(daemon: Pick<DaemonState, "connection" | "agent" | "source">) {
  if (daemon.source === "sample") return "bg-muted-foreground/50";
  if (daemon.connection !== "open") return "bg-bad";
  const s = daemon.agent?.state;
  // Ready = the agent's own colour (lavender); working = amber; trouble = coral.
  if (s === "idle") return "bg-ai";
  if (s === "busy" || s === "starting") return "bg-warn";
  return "bg-bad";
}

export function agentStatusLabel(daemon: DaemonState) {
  if (daemon.source === "sample") return "No daemon connected — showing sample data";
  if (daemon.source === null || daemon.connection === "connecting") return "Connecting to the daemon…";
  if (daemon.connection === "closed") return "Daemon disconnected — reconnecting";
  const a = daemon.agent?.agent;
  const who = a ? `${a.name} ${a.version}` : "Agent";
  return `${who} · ${daemon.agent?.state ?? "unknown"}${daemon.daemonVersion ? ` · daemon ${daemon.daemonVersion}` : ""}`;
}

/** Starts a new chat (§5), or on older daemons a fresh agent session. */
export function NewSessionButton({ daemon }: { daemon: DaemonState }) {
  const connected = daemon.source === "daemon" && daemon.connection === "open";
  const running = daemon.turns.some((t) => !t.stopReason);
  if (!connected || daemon.turns.length === 0) return null;
  const label = daemon.projectsSupported
    ? "New chat — this one stays in the Chats list"
    : "New session — the agent forgets this chat";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={running && !daemon.projectsSupported}
          onClick={resetSession}
          aria-label={daemon.projectsSupported ? "New chat" : "New session"}
          className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
        >
          {daemon.projectsSupported ? <MessageSquarePlus className="size-3.5" /> : <RotateCcw className="size-3.5" />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

export function AgentPanel({
  node,
  contextPath,
  daemon,
  architecture,
  onOpenPath,
  onClearContext,
  focusSignal = 0,
  focusTurnId = null,
  onPickContext,
  keyboard = true,
}: {
  node: DiagramNode | null;
  contextPath: string;
  daemon: DaemonState;
  architecture: Architecture;
  onOpenPath: (path: string) => void;
  onClearContext?: (() => void) | undefined;
  /** Bumped by "Ask agent": focus the composer. */
  focusSignal?: number;
  /** Scroll this turn into view (dashboard / session list). */
  focusTurnId?: string | null;
  /** Offer an "add context" button when nothing is selected. */
  onPickContext?: (() => void) | undefined;
  /** Only one mounted panel should own the permission keyboard shortcuts. */
  keyboard?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const composerRef = useRef<ComposerHandle | null>(null);
  const turns = daemon.turns;
  const latest = turns[turns.length - 1];
  const running = !!latest && !latest.stopReason;
  const connected = daemon.source === "daemon" && daemon.connection === "open";

  const pathFor = useMemo(() => {
    const byId = new Map(architecture.nodes.map((n) => [n.id, n]));
    return (nodeId: string) => {
      const n = byId.get(nodeId);
      return n ? contextPathOf(n) : nodeId;
    };
  }, [architecture]);

  // Follow the stream while the reader is at the bottom; leave them alone when they scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [turns]);

  useEffect(() => {
    if (focusSignal > 0) composerRef.current?.focus();
  }, [focusSignal]);

  useEffect(() => {
    if (!focusTurnId) return;
    const el = document.getElementById(`turn-${focusTurnId}`);
    if (!el) return;
    stickRef.current = false;
    el.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [focusTurnId]);

  const send = (text: string) => {
    if (!node || running) return;
    stickRef.current = true;
    sendPrompt(node.id, text);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {turns.length === 0 && daemon.chatLoading ? (
          <div className="mx-auto w-full max-w-[46rem] space-y-6 px-4 pt-6" aria-busy="true" aria-label="Loading chat">
            {[0, 1].map((i) => (
              <div key={i} className="space-y-2.5">
                <div className="ms-auto h-8 w-2/5 animate-pulse rounded-2xl bg-surface-2" />
                <div className="h-3 w-4/5 animate-pulse rounded bg-surface-2" />
                <div className="h-3 w-3/5 animate-pulse rounded bg-surface-2" />
                <div className="h-3 w-2/3 animate-pulse rounded bg-surface-2" />
              </div>
            ))}
          </div>
        ) : turns.length === 0 ? (
          <div className="mx-auto flex h-full max-w-[26rem] flex-col items-center justify-center gap-3 px-6 py-10 text-center">
            <Phantom expression={connected ? "agent" : "thinking"} size={56} />
            <div className="space-y-1.5">
              <p className="heading text-[16px] text-foreground">
                {node ? `Ask about ${node.label}` : "Ask Ruah about this codebase"}
              </p>
              <p className="text-[12.5px] leading-relaxed text-muted-foreground">
                {!connected
                  ? "The agent runs inside the Ruah daemon. Start `archmap serve <repo>` and open the page it serves."
                  : node
                    ? "Its path, files, links and workflows are attached to your message."
                    : onPickContext
                      ? "Add an element as context, or select one on the map. Its path, files and links travel with your message."
                      : "Select an element on the diagram. Its context is attached to what you ask."}
              </p>
            </div>
            {connected && node ? (
              <div className="mt-1 flex w-full flex-col gap-1">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => send(s)}
                    className="rounded-pill border border-hairline bg-surface-1 px-3 py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:border-ai/45 hover:bg-ai/10 hover:text-foreground"
                  >
                    {s}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="mx-auto w-full max-w-[46rem] space-y-7 px-4 pt-5 pb-6">
            {turns.map((t, i) => (
              <TurnView
                key={t.id}
                turn={t}
                contextPath={pathFor(t.nodeId)}
                running={i === turns.length - 1 && !t.stopReason}
                onOpenPath={onOpenPath}
                keyboard={keyboard}
              />
            ))}
          </div>
        )}
      </div>

      <div className={cn("mx-auto w-full max-w-[46rem] shrink-0 px-3 pb-3", turns.length ? "pt-1" : "")}>
        <Composer
          ref={composerRef}
          node={node}
          contextPath={contextPath}
          daemon={daemon}
          running={running}
          onSend={send}
          onStop={() => latest && cancel(latest.id)}
          onClearContext={onClearContext}
          onPickContext={onPickContext}
          keyboard={keyboard}
        />
      </div>
    </div>
  );
}
