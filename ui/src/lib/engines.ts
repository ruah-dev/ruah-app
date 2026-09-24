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
    if (daemon.connection !== "open") return;
    void fetch("/api/engines/verify/state")
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { nodes?: Record<string, NodeVerifyState> } | null) => {
        if (body?.nodes) setNodes(body.nodes);
      })
      .catch(() => {});
  }, [daemon.connection]);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);
  // Refresh when a turn finishes so badges update without waiting for the poll.
  useEffect(() => {
    if (daemon.connection !== "open") return;
    const onFinished = (): void => {
      window.setTimeout(refresh, 800);
    };
    window.addEventListener("ruah:turn-finished", onFinished);
    return () => window.removeEventListener("ruah:turn-finished", onFinished);
  }, [daemon.connection, refresh]);
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

export interface EngineToolStatus {
  installed: boolean;
  install: string;
}

export async function engineStatus(): Promise<Record<string, EngineToolStatus>> {
  const res = await fetch("/api/engines/status");
  if (!res.ok) return {};
  return res.json();
}

export interface GuardScan {
  findings?: unknown[];
  summary?: { filesScanned?: number; total?: number; failed?: boolean };
  error?: string;
}

export async function guardScan(): Promise<GuardScan | { error: string }> {
  const res = await fetch("/api/engines/guard/scan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const body = (await res.json()) as GuardScan & { error?: string };
  if (!res.ok) return { error: body.error ?? `guard failed (${res.status})` };
  return body;
}

export interface GuardAudit {
  entries?: unknown[];
  count?: number;
  error?: string;
}

export async function guardAudit(): Promise<GuardAudit | { error: string }> {
  const res = await fetch("/api/engines/guard/audit");
  const body = (await res.json()) as GuardAudit & { error?: string };
  if (!res.ok) return { error: body.error ?? `audit failed (${res.status})` };
  return body;
}

export interface OptUsage {
  records: number;
  summary: { totalTokens: number; costUsd: number };
  topSpenders: Array<{ by: string; key: string; tokens: number; costUsd: number }>;
  waste: Array<{ signal: string; detail: string }>;
  suggestions: string[];
  error?: string;
}

export async function optUsage(): Promise<OptUsage | { error: string }> {
  const res = await fetch("/api/engines/opt/usage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const body = (await res.json()) as OptUsage & { error?: string };
  if (!res.ok) return { error: body.error ?? `opt failed (${res.status})` };
  return body;
}

export async function watchReplay(
  projectId: string,
  chatId: string,
  turnId: string,
): Promise<{ path: string; name: string; turns: number } | { error: string }> {
  const res = await fetch("/api/engines/watch/replay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, chatId, turnId }),
  });
  const body = (await res.json()) as { path?: string; name?: string; turns?: number; error?: string };
  if (!res.ok || !body.path || !body.name) return { error: body.error ?? `replay failed (${res.status})` };
  return { path: body.path, name: body.name, turns: body.turns ?? 0 };
}
