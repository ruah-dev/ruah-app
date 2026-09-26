// ui/src/lib/engines.ts — client for /api/engines/*. Every call goes to the connected daemon's
// origin and only while the viewer shows the daemon's project: with the bundled sample on screen
// (no daemon at first) nothing here reaches a daemon — a scan, an eval or a replay would act on
// whatever real project it has open, not on the sample the user is looking at.
import { useCallback, useEffect, useState } from "react";
import { daemonSnapshot, SAMPLE_MODE_MESSAGE, sameRoot, useDaemonSelector } from "./daemon";

/** The daemon URL for an engines path; undefined while there is no daemon project to act on. */
export function engineUrl(path: string): string | undefined {
  const s = daemonSnapshot();
  if (s.source !== "daemon" || !s.httpOrigin) return undefined;
  return `${s.httpOrigin}${path}`;
}

function notConnected(): { error: string } {
  return { error: daemonSnapshot().source === "sample" ? SAMPLE_MODE_MESSAGE : "No Ruah daemon connected" };
}

export type VerifyBadge = "pass" | "fail" | "unverifiable" | "error" | "idle";

export interface NodeVerifyState {
  nodeId: string;
  badge: VerifyBadge;
  verdict?: string;
  detail?: string;
  verifiedAt?: string;
}

/**
 * The open project's verify badges (polled every 4 s, and after each turn). Scoped to the
 * project: a switch clears them at once, and an answer about another project (a poll that was in
 * flight during the switch; the daemon names the root it answered for) is dropped.
 */
export function useVerifyState(): [Record<string, NodeVerifyState>, () => void] {
  const connected = useDaemonSelector((s) => s.source === "daemon" && s.connection === "open");
  // No badges while a switch is under way (a previewed target shows the new map already).
  const root = useDaemonSelector((s) => (s.source === "daemon" && !s.projectSwitch ? (s.project?.root ?? s.root) : null));
  const [state, setState] = useState<{ root: string | null; nodes: Record<string, NodeVerifyState> }>({ root: null, nodes: {} });
  const refresh = useCallback(() => {
    if (!connected || !root) return;
    const asked = root;
    const url = engineUrl("/api/engines/verify/state");
    if (!url) return;
    void fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: VerifyStateAnswer | null) => {
        const nodes = verifyAnswerFor(asked, body);
        if (nodes) setState({ root: asked, nodes });
      })
      .catch(() => {});
  }, [connected, root]);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);
  // Refresh when a turn finishes so badges update without waiting for the poll.
  useEffect(() => {
    if (!connected) return;
    const onFinished = (): void => {
      window.setTimeout(refresh, 800);
    };
    window.addEventListener("ruah:turn-finished", onFinished);
    return () => window.removeEventListener("ruah:turn-finished", onFinished);
  }, [connected, refresh]);
  return [connected ? visibleVerifyNodes(state, root) : EMPTY_NODES, refresh];
}

const EMPTY_NODES: Record<string, NodeVerifyState> = {};

/** GET /api/engines/verify/state (`root` since §20.4). */
export interface VerifyStateAnswer {
  root?: string | null;
  nodes?: Record<string, NodeVerifyState>;
}

/** The badges of an answer to a poll made for `asked`; undefined when it is about another project. */
export function verifyAnswerFor(asked: string, body: VerifyStateAnswer | null): Record<string, NodeVerifyState> | undefined {
  if (!body?.nodes) return undefined;
  if (body.root !== undefined && body.root !== null && !sameRoot(body.root, asked)) return undefined;
  return body.nodes;
}

/** What the map shows: the badges only while they belong to the open project (none mid-switch). */
export function visibleVerifyNodes(
  state: { root: string | null; nodes: Record<string, NodeVerifyState> },
  current: string | null,
): Record<string, NodeVerifyState> {
  return current !== null && state.root !== null && sameRoot(state.root, current) ? state.nodes : EMPTY_NODES;
}

export async function runVerify(nodeId: string): Promise<NodeVerifyState | { error: string }> {
  const url = engineUrl("/api/engines/verify/run");
  if (!url) return notConnected();
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nodeId }),
  });
  const body = (await res.json()) as NodeVerifyState & { error?: string };
  if (!res.ok) return { error: body.error ?? `verify failed (${res.status})` };
  return body;
}

export async function syncVerify(): Promise<{ path: string; criteriaCount: number } | { error: string }> {
  const url = engineUrl("/api/engines/verify/sync");
  if (!url) return notConnected();
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const body = (await res.json()) as { path?: string; criteriaCount?: number; error?: string };
  if (!res.ok) return { error: body.error ?? `sync failed (${res.status})` };
  return { path: body.path!, criteriaCount: body.criteriaCount! };
}

export async function runEval(nodeId: string, prompt: string): Promise<unknown> {
  const url = engineUrl("/api/engines/eval/run");
  if (!url) return notConnected();
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nodeId, prompt }),
  });
  return res.json();
}

export async function detectConv(nodeId: string): Promise<{ specs: Array<{ path: string; kind: string }> }> {
  const url = engineUrl(`/api/engines/conv/detect?nodeId=${encodeURIComponent(nodeId)}`);
  if (!url) return { specs: [] };
  const res = await fetch(url);
  return res.json();
}

export async function runConv(
  nodeId: string,
  specPath: string,
  command: "inspect" | "curate" | "generate" | "validate",
): Promise<unknown> {
  const url = engineUrl("/api/engines/conv/run");
  if (!url) return notConnected();
  const res = await fetch(url, {
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
  const url = engineUrl("/api/engines/status");
  if (!url) return {};
  const res = await fetch(url);
  if (!res.ok) return {};
  return res.json();
}

export interface GuardScan {
  findings?: unknown[];
  summary?: { filesScanned?: number; total?: number; failed?: boolean };
  error?: string;
}

export async function guardScan(): Promise<GuardScan | { error: string }> {
  const url = engineUrl("/api/engines/guard/scan");
  if (!url) return notConnected();
  const res = await fetch(url, {
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
  const url = engineUrl("/api/engines/guard/audit");
  if (!url) return notConnected();
  const res = await fetch(url);
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
  const url = engineUrl("/api/engines/opt/usage");
  if (!url) return notConnected();
  const res = await fetch(url, {
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
  const url = engineUrl("/api/engines/watch/replay");
  if (!url) return notConnected();
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, chatId, turnId }),
  });
  const body = (await res.json()) as { path?: string; name?: string; turns?: number; error?: string };
  if (!res.ok || !body.path || !body.name) return { error: body.error ?? `replay failed (${res.status})` };
  return { path: body.path, name: body.name, turns: body.turns ?? 0 };
}
