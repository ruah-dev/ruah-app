// src/activity/run-activity.ts — `ruah app activity [--since <duration>] [--json]`
// (CONTRACTS §13.2): what agents did across projects, from the persisted feed
// ($RUAH_HOME/activity.jsonl) and the unread markers (state.json per project).
// A daemon answering on --daemon (default RUAH_DAEMON_URL, else
// http://127.0.0.1:4177) adds live counts; none is required (--offline).
import { parseArgs } from "node:util";
import type { ActivityEvent, ProjectActivity } from "../contracts/ws.js";
import { ruahHome } from "../usage/log.js";
import { ChatStore } from "../projects/chat-store.js";
import { ProjectsStore } from "../projects/projects-store.js";
import { ActivityLog, parseSince } from "./log.js";
import { DEFAULT_DAEMON_URL, fetchLive, relativeTime, type CliIo } from "../resume/run-resume.js";
import { resolveProject } from "../resume/resume.js";

const defaultIo: CliIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

export interface ActivityReport {
  since: string;
  /** Whether a running daemon supplied live counts. */
  daemon: boolean;
  projects: ProjectActivity[];
  events: ActivityEvent[];
}

/** Builds the report from disk (+ live counts when given). */
export function activityReport(
  home: string,
  options: { since: Date; projectId?: string; limit?: number; live?: Map<string, { running: number; waitingPermission: number }> },
): ActivityReport {
  const chats = new ChatStore(home);
  const projects = new ProjectsStore(home);
  const log = new ActivityLog(home);
  const events = log.read({ since: options.since, ...(options.projectId !== undefined ? { projectId: options.projectId } : {}), ...(options.limit !== undefined ? { limit: options.limit } : {}) });
  const ids = new Set<string>([...projects.list().map((p) => p.id), ...events.map((e) => e.projectId), ...(options.live?.keys() ?? [])]);
  const out: ProjectActivity[] = [];
  for (const id of ids) {
    if (options.projectId !== undefined && id !== options.projectId) continue;
    const identity = projects.lookup(id);
    const unreadByChat = chats.state.unread(id);
    const live = options.live?.get(id);
    const last = [...events].reverse().find((e) => e.projectId === id);
    const entry: ProjectActivity = {
      projectId: id,
      projectName: identity?.name ?? last?.projectName ?? id,
      ...((identity?.root ?? last?.projectRoot) !== undefined ? { projectRoot: identity?.root ?? last?.projectRoot } : {}),
      running: live?.running ?? 0,
      waitingPermission: live?.waitingPermission ?? 0,
      unread: Object.values(unreadByChat).reduce((sum, n) => sum + n, 0),
      chats: unreadByChat,
      ...(last !== undefined ? { lastEventAt: last.at } : {}),
    };
    const eventsHere = events.some((e) => e.projectId === id);
    if (entry.running > 0 || entry.waitingPermission > 0 || entry.unread > 0 || eventsHere) out.push(entry);
  }
  out.sort((a, b) => b.waitingPermission - a.waitingPermission || b.unread - a.unread || b.running - a.running || (b.lastEventAt ?? "").localeCompare(a.lastEventAt ?? ""));
  return { since: options.since.toISOString(), daemon: options.live !== undefined, projects: out, events };
}

function formatReport(report: ActivityReport, now: Date): string {
  const lines: string[] = [];
  if (report.projects.length === 0 && report.events.length === 0) {
    return `No agent activity since ${relativeTime(report.since, now)}.\n`;
  }
  lines.push("Projects");
  for (const p of report.projects) {
    const parts: string[] = [];
    if (p.waitingPermission > 0) parts.push(`${p.waitingPermission} waiting for permission`);
    if (p.running > 0) parts.push(`${p.running} running`);
    if (p.unread > 0) parts.push(`${p.unread} unread`);
    if (p.lastEventAt !== undefined) parts.push(`last ${relativeTime(p.lastEventAt, now)}`);
    lines.push(`  ${p.projectName.padEnd(24)} ${parts.join(" · ")}`);
  }
  if (report.events.length > 0) {
    lines.push("", `Events (since ${relativeTime(report.since, now)})`);
    for (const e of report.events) {
      const mark = e.kind === "permission.requested" ? "!" : e.kind === "turn.finished" && e.stopReason === "error" ? "x" : e.background ? "•" : " ";
      lines.push(`  ${mark} ${relativeTime(e.at, now).padEnd(9)} ${e.projectName.padEnd(20)} ${e.summary}`);
    }
  }
  if (!report.daemon) lines.push("", "(no daemon running: live turn counts are not shown)");
  return `${lines.join("\n")}\n`;
}

export async function runActivity(argv: readonly string[], io: CliIo = defaultIo): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        since: { type: "string", default: "24h" },
        json: { type: "boolean", default: false },
        project: { type: "string" },
        limit: { type: "string" },
        daemon: { type: "string" },
        offline: { type: "boolean", default: false },
      },
      allowPositionals: false,
      strict: true,
    }));
  } catch (err) {
    io.err(`ruah app activity: ${(err as Error).message}\n`);
    return 2;
  }
  const now = io.now?.() ?? new Date();
  const since = parseSince(values.since ?? "24h", now);
  if (since === undefined) {
    io.err(`ruah app activity: --since must be a duration (90m, 24h, 7d) or an ISO time\n`);
    return 2;
  }
  const home = io.deps?.home ?? ruahHome();
  let projectId: string | undefined;
  if (values.project !== undefined) {
    projectId = resolveProject(values.project, { home })?.id;
    if (projectId === undefined) {
      io.err(`ruah app activity: no such project or folder: ${values.project}\n`);
      return 1;
    }
  }
  const rawLimit = values.limit !== undefined ? Number.parseInt(values.limit, 10) : undefined;
  const limit = rawLimit !== undefined && Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 200;
  const live = await fetchLive(values.offline === true ? undefined : (values.daemon ?? process.env.RUAH_DAEMON_URL ?? DEFAULT_DAEMON_URL));
  const report = activityReport(home, { since, limit, ...(projectId !== undefined ? { projectId } : {}), ...(live !== undefined ? { live } : {}) });
  io.out(values.json === true ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report, now));
  return 0;
}
