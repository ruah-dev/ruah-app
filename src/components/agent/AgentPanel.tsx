import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, RotateCcw, Square } from "lucide-react";
import type { DiagramNode } from "@/data/graphs";
import type { Architecture } from "@/lib/contracts";
import { contextPathOf } from "@/lib/architecture";
import { cancel, resetSession, sendPrompt, setAgentMode, type DaemonState } from "@/lib/daemon";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { PermissionCard } from "./PermissionCard";
import { TurnView } from "./TurnView";

const suggestions = [
  "Explain this flow",
  "Where are the API requests handled?",
  "What breaks if this fails?",
];

export function agentDotClass(daemon: Pick<DaemonState, "connection" | "agent">) {
  if (daemon.connection !== "open") return "bg-bad";
  const s = daemon.agent?.state;
  if (s === "idle") return "bg-ok";
  if (s === "busy" || s === "starting") return "bg-warn";
  return "bg-bad";
}

export function AgentPanel({
  node,
  contextPath,
  daemon,
  architecture,
  onOpenPath,
  keyboard = true,
}: {
  node: DiagramNode;
  contextPath: string;
  daemon: DaemonState;
  architecture: Architecture;
  onOpenPath: (path: string) => void;
  /** Only one mounted panel should own the permission keyboard shortcuts. */
  keyboard?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const turns = daemon.turns;
  const latest = turns[turns.length - 1];
  const running = !!latest && !latest.stopReason;
  const pending = turns.find((t) => t.permission)?.permission ?? null;
  const connected = daemon.source === "daemon" && daemon.connection === "open";

  const pathFor = useMemo(() => {
    const byId = new Map(architecture.nodes.map((n) => [n.id, n]));
    return (nodeId: string) => {
      const n = byId.get(nodeId);
      return n ? contextPathOf(n) : nodeId;
    };
  }, [architecture]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  useEffect(() => {
    if (!running) inputRef.current?.focus();
  }, [running, node.id]);

  const send = (text: string) => {
    const prompt = text.trim();
    if (!prompt || running) return;
    sendPrompt(node.id, prompt);
    setDraft("");
  };

  const modes = daemon.agent?.modes;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-hairline px-3">
        <span className={cn("size-1.5 shrink-0 rounded-full", agentDotClass(daemon))} />
        <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">
          {connected
            ? `${daemon.agent?.agent ? `${daemon.agent.agent.name} ${daemon.agent.agent.version}` : "agent"} · ${daemon.agent?.state ?? "unknown"}`
            : "no daemon connected"}
        </span>
        {connected && modes?.available.length ? (
          <select
            aria-label="Agent permission mode"
            value={modes.currentModeId}
            disabled={running}
            onChange={(e) => setAgentMode(e.target.value)}
            className="ml-auto h-6 max-w-32 rounded-[4px] border border-hairline bg-surface-2 px-1 text-[10.5px] text-foreground outline-none"
          >
            {modes.available.map((m) => (
              <option key={m.id} value={m.id} title={m.description}>
                {m.name}
              </option>
            ))}
          </select>
        ) : null}
        {connected ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={running}
            onClick={resetSession}
            title="Start a new agent session (the agent forgets this conversation)"
            className={cn(
              "h-6 gap-1 px-1.5 text-[10.5px] text-muted-foreground",
              modes?.available.length ? "" : "ml-auto",
            )}
          >
            <RotateCcw className="size-3" />
            New session
          </Button>
        ) : null}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-auto px-3 py-3">
        {turns.length === 0 ? (
          <p className="text-[11.5px] text-muted-foreground">
            {connected
              ? "Ask anything about this element. The daemon attaches its context pack (path, files, links, workflows) automatically."
              : "The agent runs inside the archmap daemon. Start `archmap serve <repo>` and open the page it serves to chat about this element."}
          </p>
        ) : null}
        {turns.map((t, i) => (
          <TurnView
            key={t.id}
            turn={t}
            contextPath={pathFor(t.nodeId)}
            running={i === turns.length - 1 && !t.stopReason}
            onOpenPath={onOpenPath}
          />
        ))}
      </div>

      <div className="space-y-2 border-t border-hairline bg-surface-1 p-3">
        {pending ? (
          <PermissionCard request={pending} onOpenPath={onOpenPath} keyboard={keyboard} />
        ) : null}
        {!running && connected ? (
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((s) => (
              <Button
                key={s}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => send(s)}
                className="h-6 rounded-[4px] border-hairline bg-surface-2 px-2 text-[10px] text-muted-foreground shadow-none hover:bg-surface-3 hover:text-foreground"
              >
                {s}
              </Button>
            ))}
          </div>
        ) : null}
        <Textarea
          ref={inputRef}
          value={draft}
          disabled={running}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(draft);
            }
          }}
          rows={2}
          placeholder={running ? "Agent is working…" : `Ask about ${node.label}…`}
          className="resize-none rounded-md border-hairline bg-surface-2 font-mono text-[11.5px] shadow-none"
        />
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-mono text-[10px] text-primary">@{contextPath}</span>
          {running && latest ? (
            <Button
              size="sm"
              variant="outline"
              className="h-6 gap-1 px-2 text-[11px]"
              onClick={() => cancel(latest.id)}
            >
              <Square className="size-3" /> Stop
            </Button>
          ) : (
            <Button size="sm" className="h-6 gap-1 px-2 text-[11px]" onClick={() => send(draft)}>
              Send <ArrowUp className="size-3" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
