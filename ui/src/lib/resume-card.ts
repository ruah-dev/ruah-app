// "Where you left off" (CONTRACTS.md §13.4) as the shell shows it: when the floating card appears
// and what it lists. Pure; unit-tested in ui/test/resume-card.test.ts.
import type { ResumeInfo } from "./contracts";

/** Something happened in the project since the user last left it (not just a dirty tree). */
export function hasNews(resume: ResumeInfo): boolean {
  const s = resume.since;
  return (
    s.turnsFinished + s.turnsFailed + s.permissionsRequested + s.mapChanges > 0 ||
    s.filesTotal > 0 ||
    resume.unread > 0 ||
    (resume.live?.waitingPermission ?? 0) > 0
  );
}

/**
 * The card shows when switching into a project that has news since the last view. Never on the
 * first open of a project (no `lastViewedAt`: the user was never here), never while a switch is
 * still painting, and not again once dismissed for this visit (`dismissedFor` = the lastViewedAt
 * the user dismissed; a later visit has a newer one).
 */
export function shouldShowResumeCard(opts: {
  resume: ResumeInfo | null;
  projectId: string | null;
  dismissedFor: string | null;
  switching: boolean;
  enabled?: boolean;
}): boolean {
  const { resume, projectId } = opts;
  if (opts.enabled === false || opts.switching || !resume || !projectId) return false;
  if (resume.project.id !== projectId) return false;
  if (resume.lastViewedAt === null) return false;
  if (opts.dismissedFor === resume.lastViewedAt) return false;
  return hasNews(resume);
}

export type AwayTone = "ok" | "warn" | "bad" | "ai";
export interface AwayItem {
  key: string;
  tone: AwayTone;
  text: string;
  /** A quoted part shown emphasised (a chat title). */
  strong?: string;
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** The "While you were away" lines, most important first (at most `max`). */
export function awayItems(resume: ResumeInfo, max = 4): AwayItem[] {
  const s = resume.since;
  const items: AwayItem[] = [];
  const waiting = resume.live?.waitingPermission ?? 0;
  if (waiting > 0 || s.permissionsRequested > 0) {
    const n = waiting || s.permissionsRequested;
    items.push({ key: "perm", tone: "warn", text: `${plural(n, "permission request")} ${waiting > 0 ? "waiting for you" : "while you were away"}` });
  }
  const finished = [...s.events].reverse().find((e) => e.kind === "turn.finished" && e.stopReason === "end_turn");
  if (s.turnsFinished > 0) {
    const extras = [
      s.filesTotal ? plural(s.filesTotal, "file") : "",
      s.mapChanges ? `${plural(s.mapChanges, "change")} on the map` : "",
    ].filter(Boolean);
    const quoted = finished ? /"([^"]+)"/.exec(finished.summary)?.[1] : undefined;
    items.push({
      key: "done",
      tone: "ok",
      text: `${quoted ? "Agent finished" : `Agents finished ${plural(s.turnsFinished, "turn")}`}${extras.length ? ` — ${extras.join(", ")}` : ""}`,
      ...(quoted ? { strong: quoted } : {}),
    });
  }
  if (s.turnsFailed > 0) items.push({ key: "failed", tone: "bad", text: `${plural(s.turnsFailed, "turn")} failed or stopped` });
  if ((resume.live?.running ?? 0) > 0)
    items.push({ key: "running", tone: "ai", text: `${plural(resume.live!.running, "agent")} still working` });
  if (resume.ruah.initialized) {
    const active = resume.ruah.tasks.filter((t) => t.status === "in-progress");
    if (active.length)
      items.push({
        key: "tasks",
        tone: "ai",
        text: active.length === 1 ? `ruah task ${active[0]!.name} is still running` : `${active.length} ruah tasks still running`,
      });
  }
  if (!s.turnsFinished && s.filesTotal > 0)
    items.push({ key: "files", tone: "ai", text: `${plural(s.filesTotal, "file")} edited by agents` });
  return items.slice(0, max);
}

/** "Last here 2 days ago" style age (coarse). */
export function sinceLabel(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}
