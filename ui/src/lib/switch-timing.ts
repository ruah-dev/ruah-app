// Measures project → project and chat → chat switches: from the click (or key) to the frame
// that shows the target view (Performance API marks + measures). The shell calls
// `checkSwitchPainted` after each commit; the result lands in performance entries named
// "ruah:switch:<kind>:<phase>" and in window.__ruahSwitchTimings (read by the e2e script).

export type SwitchKind = "project" | "chat";
/** preview = painted from the viewer cache; live = the daemon's data is on screen. */
export type SwitchPhase = "preview" | "live";

export interface SwitchTiming {
  kind: SwitchKind;
  phase: SwitchPhase;
  target: string;
  ms: number;
  cached: boolean;
}

interface Pending {
  kind: SwitchKind;
  target: string;
  mark: string;
  cached: boolean;
  done: Set<SwitchPhase>;
}

let pending: Pending | null = null;
let seq = 0;

declare global {
  interface Window {
    __ruahSwitchTimings?: SwitchTiming[];
  }
}

function perf(): Performance | null {
  return typeof performance !== "undefined" && typeof performance.mark === "function" ? performance : null;
}

/** Starts timing a switch to `target` (a project id / root, or a chat id). */
export function markSwitchStart(kind: SwitchKind, target: string, cached: boolean): void {
  const p = perf();
  if (!p) return;
  seq += 1;
  const mark = `ruah:switch:start:${seq}`;
  p.mark(mark);
  pending = { kind, target, mark, cached, done: new Set() };
}

/** Upgrades the running measurement's cache flag (the preview got applied). */
export function markSwitchCached(): void {
  if (pending) pending.cached = true;
}

export function switchPending(): { kind: SwitchKind; target: string } | null {
  return pending ? { kind: pending.kind, target: pending.target } : null;
}

/**
 * Called after a commit that shows `phase` of the pending switch. Measures after the next
 * frame is painted (rAF + a macrotask ≈ "pixels on screen").
 */
export function reportSwitchPainted(kind: SwitchKind, target: string, phase: SwitchPhase): void {
  const current = pending;
  if (!current || current.kind !== kind || current.target !== target || current.done.has(phase)) return;
  current.done.add(phase);
  if (phase === "live") pending = null;
  const finish = () => {
    const p = perf();
    if (!p) return;
    const name = `ruah:switch:${kind}:${phase}`;
    try {
      const m = p.measure(name, current.mark);
      const entry: SwitchTiming = { kind, phase, target, ms: Math.round(m.duration * 10) / 10, cached: current.cached };
      if (typeof window !== "undefined") (window.__ruahSwitchTimings ??= []).push(entry);
    } catch {
      /* mark cleared */
    }
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => setTimeout(finish, 0));
  else finish();
}
