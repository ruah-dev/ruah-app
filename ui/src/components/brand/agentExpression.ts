// Which face the agent's ghost makes, from the daemon state and the latest turn:
//   idle → idle · starting / warming / queued → loading · busy or a streaming turn → thinking ·
//   waiting on a permission → warning · a turn that just finished well → success (~2 s, then
//   idle) · agent error, or a turn that failed → error (~4 s for a turn; as long as it lasts for
//   the agent).
import { useEffect, useState } from "react";
import type { DaemonState, Turn } from "@/lib/daemon";
import type { PhantomExpression } from "./Phantom";

const SUCCESS_MS = 2000;
const ERROR_MS = 4000;

type AgentView = Pick<DaemonState, "source" | "connection" | "agent" | "agentSwitch" | "turns">;

export function turnFailed(t: Pick<Turn, "stopReason" | "error">) {
  return t.stopReason === "error" || (t.stopReason === "cancelled" && !!t.error);
}

/** The steady expression (no success / error flash). */
export function agentExpressionOf(d: AgentView): PhantomExpression {
  if (d.source === "sample") return "idle";
  if (d.source === null || d.connection === "connecting") return "loading";
  if (d.connection === "closed") return "error";
  if (d.agentSwitch) return "loading";
  const latest = d.turns[d.turns.length - 1];
  if (latest && !latest.stopReason) {
    if (latest.permission) return "warning";
    if (latest.waitingFor) return "loading";
    return "thinking";
  }
  const s = d.agent?.state;
  if (s === "starting") return "loading";
  if (s === "busy") return "thinking";
  if (s === "error" || s === "stopped") return "error";
  return "idle";
}

/** A short success / error face right after the latest turn finishes. */
function flashOf(latest: Turn | undefined): { expression: PhantomExpression; until: number } | null {
  if (!latest?.stopReason || latest.finishedAt === undefined) return null;
  const failed = turnFailed(latest);
  const until = latest.finishedAt + (failed ? ERROR_MS : SUCCESS_MS);
  if (until <= Date.now()) return null;
  if (failed) return { expression: "error", until };
  if (latest.stopReason === "end_turn") return { expression: "success", until };
  return null;
}

/** agentExpressionOf, plus the success / error flash when a turn has just finished. */
export function useAgentExpression(d: AgentView): PhantomExpression {
  const latest = d.turns[d.turns.length - 1];
  const flash = flashOf(latest);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => tick((n) => n + 1), Math.max(0, flash.until - Date.now()) + 20);
    return () => clearTimeout(t);
  }, [flash?.until]);
  const steady = agentExpressionOf(d);
  // A new turn, a permission or a lost connection outrank the flash.
  if (flash && steady === "idle") return flash.expression;
  return steady;
}

export const agentExpressionLabel: Record<PhantomExpression, string> = {
  idle: "Agent ready",
  tracking: "Agent ready",
  agent: "Agent",
  thinking: "Agent working",
  loading: "Agent starting",
  warning: "Agent waiting for your permission",
  success: "Agent finished",
  error: "Agent error",
};
