// ui/src/lib/engines.ts — client for /api/engines/*
import { useCallback, useEffect, useState } from "react";
import { useDaemon } from "./daemon";

export type VerifyBadge = "pass" | "fail" | "unverifiable" | "error" | "idle";

export interface NodeVerifyState {
  nodeId: string;
  badge: VerifyBadge;
  verdict?: string;
  detail?: string;
  verifiedAt?: string;
}

export function useVerifyState(): [Record<string, NodeVerifyState>, () => void] {
  const daemon = useDaemon();
  const [nodes, setNodes] = useState<Record<string, NodeVerifyState>>({});
  const refresh = useCallback(() => {
    if (!daemon.connected) return;
    void fetch("/api/engines/verify/state")
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { nodes?: Record<string, NodeVerifyState> } | null) => {
        if (body?.nodes) setNodes(body.nodes);
      })
      .catch(() => {});
  }, [daemon.connected]);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);
  // Refresh when a turn finishes so badges update without waiting for the poll.
  useEffect(() => {
    if (!daemon.connected) return;
    const onFinished = (): void => {
      window.setTimeout(refresh, 800);
    };
    window.addEventListener("ruah:turn-finished", onFinished);
    return () => window.removeEventListener("ruah:turn-finished", onFinished);
  }, [daemon.connected, refresh]);
  return [nodes, refresh];
}

export async function runVerify(nodeId: string): Promise<NodeVerifyState | { error: string }> {
  const res = await fetch("/api/engines/verify/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nodeId }),
  });
  const body = (await res.json()) as NodeVerifyState & { error?: string };
  if (!res.ok) return { error: body.error ?? `verify failed (${res.status})` };
  return body;
}

export async function syncVerify(): Promise<{ path: string; criteriaCount: number } | { error: string }> {
  const res = await fetch("/api/engines/verify/sync", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const body = (await res.json()) as { path?: string; criteriaCount?: number; error?: string };
  if (!res.ok) return { error: body.error ?? `sync failed (${res.status})` };
  return { path: body.path!, criteriaCount: body.criteriaCount! };
}

export async function runEval(nodeId: string, prompt: string): Promise<unknown> {
  const res = await fetch("/api/engines/eval/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nodeId, prompt }),
  });
  return res.json();
}

export async function detectConv(nodeId: string): Promise<{ specs: Array<{ path: string; kind: string }> }> {
  const res = await fetch(`/api/engines/conv/detect?nodeId=${encodeURIComponent(nodeId)}`);
  return res.json();
}

export async function runConv(
  nodeId: string,
  specPath: string,
  command: "inspect" | "curate" | "generate" | "validate",
): Promise<unknown> {
  const res = await fetch("/api/engines/conv/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nodeId, specPath, command }),
  });
  return res.json();
}
