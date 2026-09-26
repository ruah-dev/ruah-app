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
        if (nodes) {
          setState({ root: asked, nodes });
          announceLegacyRepoFiles(asked, body?.legacy);
        }
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

/** GET /api/engines/verify/state (`root` since §20.4, `legacy` since §20.3). */
export interface VerifyStateAnswer {
  root?: string | null;
  nodes?: Record<string, NodeVerifyState>;
  legacy?: LegacyRepoFiles;
}

/** What an older Ruah left in the repo for the user to decide on (§20.3). */
export interface LegacyRepoFiles {
  /** `.ruah/verify.json` is only the placeholder older versions wrote on their own. */
  placeholderCriteria?: string;
  /** Ruah's own old cache files still in the repo: committed ones, or ones it could not delete. */
  leftover?: string[];
}

const LEGACY_KEPT_KEY = "ruah:legacy-placeholder-kept";
/** Roots told about this session (the poll runs every 4 s: say it once). */
const legacyAnnounced = new Set<string>();

function keptRoots(): string[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(LEGACY_KEPT_KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((r): r is string => typeof r === "string") : [];
  } catch {
    return [];
  }
}

function keepPlaceholder(root: string): void {
  try {
    window.localStorage.setItem(LEGACY_KEPT_KEY, JSON.stringify([...keptRoots().filter((r) => r !== root), root].slice(-100)));
  } catch {
    // private window: asked again next session
  }
}

/** Which notice to show for an answer about `root`; undefined when there is nothing (new) to say. */
export function legacyNoticeFor(root: string, legacy: LegacyRepoFiles | undefined, kept: readonly string[]): "placeholder" | "leftover" | undefined {
  if (legacy?.placeholderCriteria && !kept.some((r) => sameRoot(r, root))) return "placeholder";
  if (legacy?.leftover && legacy.leftover.length > 0) return "leftover";
  return undefined;
}

/**
 * Once per project and session: the placeholder `.ruah/verify.json` an older Ruah wrote into the
 * repo is offered for removal (never removed without the click), and old cache files Ruah left
 * (committed ones, or ones it could not delete) are named so the user can remove them.
 */
function announceLegacyRepoFiles(root: string, legacy: LegacyRepoFiles | undefined): void {
  if (legacyAnnounced.has(root)) return;
  const notice = legacyNoticeFor(root, legacy, keptRoots());
  if (notice === undefined) return;
  legacyAnnounced.add(root);
  // Loaded here, not at module load: this module stays free of DOM side effects (tests import it).
  void import("sonner").then(({ toast }) => showLegacyNotice(toast, root, notice, legacy));
}

function showLegacyNotice(toast: typeof import("sonner").toast, root: string, notice: "placeholder" | "leftover", legacy: LegacyRepoFiles | undefined): void {
  if (notice === "leftover") {
    toast.message("Ruah's old cache files are still in this repo", {
      description: `Ruah no longer uses ${legacy?.leftover?.join(", ")} (its caches now live in Ruah's own folder). Delete them, and commit, when it suits you.`,
      duration: 12_000,
    });
    return;
  }
  toast.message("An older Ruah added .ruah/verify.json here", {
    description: "It holds no acceptance criteria. Remove it, or keep it if you committed it on purpose.",
    duration: 20_000,
    action: {
      label: "Remove",
      onClick: () => {
        void removeVerifyPlaceholder().then((r) => {
          if ("error" in r) toast.error("Couldn't remove .ruah/verify.json", { description: r.error });
          else toast.success("Removed .ruah/verify.json");
        });
      },
    },
    cancel: { label: "Keep", onClick: () => keepPlaceholder(root) },
  });
}

/** POST /api/engines/verify/remove-placeholder: only the old placeholder is ever removed. */
export async function removeVerifyPlaceholder(): Promise<{ removed: true } | { error: string }> {
  const url = engineUrl("/api/engines/verify/remove-placeholder");
  if (!url) return notConnected();
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const body = (await res.json().catch(() => ({}))) as { removed?: boolean; error?: string };
  if (!res.ok || body.removed !== true) return { error: body.error ?? `remove failed (${res.status})` };
  return { removed: true };
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

/** `written: false` when there were no criteria to sync (nothing is written then, §20.3). */
export async function syncVerify(): Promise<{ path: string; criteriaCount: number; written: boolean } | { error: string }> {
  const url = engineUrl("/api/engines/verify/sync");
  if (!url) return notConnected();
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const body = (await res.json()) as { path?: string; criteriaCount?: number; written?: boolean; error?: string };
  if (!res.ok) return { error: body.error ?? `sync failed (${res.status})` };
  return { path: body.path!, criteriaCount: body.criteriaCount!, written: body.written ?? true };
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

/**
 * One engine's availability for a component: asked again whenever the daemon connection (or the
 * project) changes — mounted before the daemon answered, a card no longer says "not installed"
 * for good. `connected: false` while there is no daemon project (the sample): nothing to run.
 */
export function useEngineTool(name: "guard" | "opt" | "watch"): { tool: EngineToolStatus | null; connected: boolean } {
  const connected = useDaemonSelector((s) => s.source === "daemon" && s.connection === "open");
  const origin = useDaemonSelector((s) => (s.source === "daemon" ? s.httpOrigin : null));
  const projectId = useDaemonSelector((s) => s.project?.id ?? null);
  const [tool, setTool] = useState<EngineToolStatus | null>(null);
  useEffect(() => {
    setTool(null);
    if (!connected || !origin) return;
    let cancelled = false;
    void engineStatus()
      .then((status) => {
        if (!cancelled) setTool(status[name] ?? { installed: false, install: `npm i -g @ruah-dev/cli @ruah-dev/${name}` });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [connected, origin, projectId, name]);
  return { tool, connected };
}

/** One status read shared by every card on screen (a chat shows a replay button per turn). */
interface StatusMemo {
  key: string;
  at: number;
  value: Promise<Record<string, EngineToolStatus>>;
}
let statusMemo: StatusMemo | null = null;
const STATUS_TTL_MS = 15_000;

export async function engineStatus(): Promise<Record<string, EngineToolStatus>> {
  const url = engineUrl("/api/engines/status");
  if (!url) return {};
  const key = `${url}|${daemonSnapshot().project?.id ?? ""}`;
  if (statusMemo && statusMemo.key === key && Date.now() - statusMemo.at < STATUS_TTL_MS) return statusMemo.value;
  const memo: StatusMemo = {
    key,
    at: Date.now(),
    value: fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`engines status ${res.status}`);
        return res.json() as Promise<Record<string, EngineToolStatus>>;
      })
      .catch((): Record<string, EngineToolStatus> => {
        // A failed read is not remembered: the next card asks again instead of "not installed" for 15 s.
        if (statusMemo === memo) statusMemo = null;
        return {};
      }),
  };
  statusMemo = memo;
  return memo.value;
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
