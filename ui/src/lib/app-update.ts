// The installed app's updates (daemon: src/desktop/self-update.ts, GET/POST /api/app-update*).
// A new commit on the checkout's branch is built in the background; this holds the last status
// the daemon reported, for the "Restart to update" chip (components/shell/useAppUpdate.tsx) and
// Settings → About. The restart decision is pure (restartDecision), unit-tested.
import { useSyncExternalStore } from "react";

export type UpdatePhase = "unsupported" | "current" | "available" | "building" | "ready" | "failed" | "installing";

export interface AppUpdateStatus {
  phase: UpdatePhase;
  reason?: string;
  current?: string;
  repo?: string;
  ref?: string;
  latest?: string;
  behind?: number;
  subject?: string;
  step?: string;
  error?: string;
  logFile?: string;
  checkedAt?: string;
  auto: boolean;
}

let status: AppUpdateStatus | null = null;
const listeners = new Set<() => void>();

function publish(next: AppUpdateStatus | null) {
  status = next;
  for (const fn of listeners) fn();
}

export function appUpdateStatus(): AppUpdateStatus | null {
  return status;
}

export function useAppUpdateStatus(): AppUpdateStatus | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => status,
    () => null,
  );
}

function isStatus(value: unknown): value is AppUpdateStatus {
  return value !== null && typeof value === "object" && typeof (value as { phase?: unknown }).phase === "string";
}

/** GET /api/app-update; null when the daemon has no updater (an older daemon, the sample). */
export async function fetchAppUpdate(origin: string): Promise<AppUpdateStatus | null> {
  try {
    const r = await fetch(`${origin}/api/app-update`, { cache: "no-store" });
    const body: unknown = r.ok ? await r.json() : null;
    const next = isStatus(body) ? body : null;
    publish(next);
    return next;
  } catch {
    return null;
  }
}

export type UpdateAction = "check" | "build" | "install";

/** POST /api/app-update/<action>; `busy` = the daemon refused a restart while an agent works. */
export async function postAppUpdate(
  origin: string,
  action: UpdateAction,
  body: Record<string, unknown> = {},
): Promise<{ ok: boolean; busy: boolean; error?: string }> {
  try {
    const r = await fetch(`${origin}/api/app-update/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await r.json().catch(() => ({}))) as { error?: string; busy?: boolean; status?: unknown };
    const next = isStatus(data) ? data : isStatus(data.status) ? data.status : null;
    if (next) publish(next);
    return { ok: r.ok, busy: data.busy === true, ...(data.error ? { error: data.error } : {}) };
  } catch (cause) {
    return { ok: false, busy: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

export type RestartDecision = "none" | "restart" | "prompt";

/**
 * A staged update restarts the app by itself only while the user is away and nothing would be
 * lost or stopped; otherwise it is offered ("Restart to update"). It also installs on quit.
 */
export function restartDecision(input: { phase: UpdatePhase | undefined; auto: boolean; away: boolean; busy: boolean }): RestartDecision {
  if (input.phase !== "ready") return "none";
  return input.auto && input.away && !input.busy ? "restart" : "prompt";
}

/** "3 new commits · fix(map): …" */
export function describeUpdate(s: Pick<AppUpdateStatus, "behind" | "subject" | "latest">): string {
  const count = s.behind !== undefined && s.behind > 0 ? `${s.behind} new commit${s.behind === 1 ? "" : "s"}` : (s.latest?.slice(0, 7) ?? "a new build");
  return s.subject ? `${count} · ${s.subject}` : count;
}
