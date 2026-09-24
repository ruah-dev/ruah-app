// src/resume/run-resume.ts — `ruah app resume [<repo-or-project-id>] [--json]`
// (CONTRACTS §13.4): "where you left off" for one project, or every recent
// project ranked by what needs attention. Reads $RUAH_HOME and the repos; a
// daemon running on --daemon (default RUAH_DAEMON_URL, else
// http://127.0.0.1:4177) adds live counts (running turns, waiting permissions)
// but is never required (--offline skips it).
import { parseArgs } from "node:util";
import type { ResumeInfo } from "../contracts/resume.js";
import type { ProjectActivity } from "../contracts/ws.js";
import { ruahHome } from "../usage/log.js";
import { computeResume, resolveProject, resumeAll, type LiveCounts, type ResumeDeps } from "./resume.js";

export const DEFAULT_DAEMON_URL = "http://127.0.0.1:4177";
const DAEMON_TIMEOUT_MS = 600;

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
  now?: () => Date;
  /** Test hook: the resume dependencies (default: $RUAH_HOME). */
  deps?: Partial<ResumeDeps>;
}

const defaultIo: CliIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

/** "3m ago", "2h ago", "5d ago" (future times read "just now"). */
export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (iso === null || iso === undefined) return "never";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const s = Math.max(0, Math.round((now.getTime() - at) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Live per-project counts from a running daemon's GET /api/activity; undefined when none answers. */
export async function fetchLive(daemonUrl: string | undefined): Promise<Map<string, LiveCounts> | undefined> {
  if (daemonUrl === undefined) return undefined;
  try {
    const res = await fetch(`${daemonUrl.replace(/\/+$/, "")}/api/activity?limit=1`, { signal: AbortSignal.timeout(DAEMON_TIMEOUT_MS) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { projects?: ProjectActivity[] };
    const out = new Map<string, LiveCounts>();
    for (const p of body.projects ?? []) out.set(p.projectId, { running: p.running, waitingPermission: p.waitingPermission });
    return out;
  } catch {
    return undefined;
  }
}

function gitLine(info: ResumeInfo, now: Date): string {
  const git = info.git;
  if (!git.available) return git.reason;
  const parts = [git.branch ?? `detached at ${git.head ?? "?"}`];
  if (git.upstream !== null && git.ahead !== null && git.behind !== null) parts.push(`↑${git.ahead} ↓${git.behind} vs ${git.upstream}`);
  parts.push(git.dirty === 0 ? "clean" : `${git.dirty} dirty: ${git.dirtyPaths.join(", ")}${git.dirty > git.dirtyPaths.length ? ", …" : ""}`);
  if (git.lastCommit !== null) parts.push(`last commit ${git.lastCommit.hash} "${git.lastCommit.subject}" (${relativeTime(git.lastCommit.at, now)})`);
  return parts.join(" · ");
}

function sinceLine(info: ResumeInfo): string {
  const s = info.since;
  const parts: string[] = [];
  if (s.turnsFinished > 0) parts.push(`${plural(s.turnsFinished, "turn")} finished`);
  if (s.turnsFailed > 0) parts.push(`${s.turnsFailed} failed`);
  if (s.permissionsRequested > 0) parts.push(plural(s.permissionsRequested, "permission request"));
  if (s.filesTotal > 0) parts.push(`${plural(s.filesTotal, "file")} edited (${s.files.slice(0, 3).join(", ")}${s.filesTotal > 3 ? ", …" : ""})`);
  if (s.mapChanges > 0) parts.push(plural(s.mapChanges, "map change"));
  return parts.length > 0 ? parts.join(" · ") : "no agent activity";
}

function badges(info: ResumeInfo): string[] {
  const out: string[] = [];
  if (info.live !== undefined && info.live.waitingPermission > 0) out.push(`${info.live.waitingPermission} waiting for permission`);
  if (info.live !== undefined && info.live.running > 0) out.push(`${plural(info.live.running, "turn")} running`);
  if (info.unread > 0) out.push(`${info.unread} unread`);
  return out;
}

/** The single-project report. */
export function formatResume(info: ResumeInfo, now: Date = new Date()): string {
  const lines: string[] = [];
  const b = badges(info);
  lines.push(`${info.project.name}  (${info.project.root})${b.length > 0 ? `  [${b.join(", ")}]` : ""}`);
  lines.push(`  left        ${info.lastViewedAt !== null ? relativeTime(info.lastViewedAt, now) : "never recorded"}`);
  if (info.lastChat !== null) {
    const c = info.lastChat;
    lines.push(`  chat        "${c.title}" · ${plural(c.turnCount, "turn")} · ${relativeTime(c.updatedAt, now)}`);
    if (c.lastPrompt !== null) lines.push(`                you:   ${c.lastPrompt}`);
    if (c.lastReply !== null) lines.push(`                agent: ${c.lastReply}`);
  } else lines.push("  chat        none yet");
  if (info.lastFocus !== null) lines.push(`  focus       ${info.lastFocus.name} (${info.lastFocus.nodeId})`);
  lines.push(`  since then  ${sinceLine(info)}`);
  lines.push(`  git         ${gitLine(info, now)}`);
  if (info.ruah.initialized) {
    const tasks = info.ruah.tasks;
    const list = tasks.map((t) => `${t.name} (${t.status})`).join(", ");
    lines.push(`  ruah        ${tasks.length === 0 ? "no open tasks" : `${plural(tasks.length, "task")}: ${list}`}${info.ruah.error !== undefined ? ` (${info.ruah.error})` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

/** One entry of the "all projects" list. */
export function formatResumeShort(info: ResumeInfo, now: Date = new Date()): string {
  const b = badges(info);
  const head = `${info.project.name}  ${info.project.root}${b.length > 0 ? `  [${b.join(", ")}]` : ""}`;
  const chat = info.lastChat !== null ? `"${info.lastChat.title}" ${relativeTime(info.lastChat.updatedAt, now)}` : "no chats";
  const git = info.git.available ? `${info.git.branch ?? "detached"}${info.git.dirty > 0 ? ` ${info.git.dirty} dirty` : ""}` : "no git";
  return `${head}\n    ${chat} · ${sinceLine(info)} · ${git}\n`;
}

export async function runResume(argv: readonly string[], io: CliIo = defaultIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        json: { type: "boolean", default: false },
        daemon: { type: "string" },
        offline: { type: "boolean", default: false },
        limit: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    io.err(`ruah app resume: ${(err as Error).message}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  const now = io.now?.() ?? new Date();
  const deps: ResumeDeps = { home: ruahHome(), ...io.deps };
  const daemonUrl = values.offline === true ? undefined : (values.daemon ?? process.env.RUAH_DAEMON_URL ?? DEFAULT_DAEMON_URL);
  const live = await fetchLive(daemonUrl);
  const target = positionals[0];
  if (target !== undefined) {
    const project = resolveProject(target, deps);
    if (project === undefined) {
      io.err(`ruah app resume: no such project or folder: ${target}\n`);
      return 1;
    }
    const liveCounts = live !== undefined ? (live.get(project.id) ?? { running: 0, waitingPermission: 0 }) : undefined;
    const info = await computeResume(project, deps, liveCounts);
    io.out(values.json === true ? `${JSON.stringify(info, null, 2)}\n` : formatResume(info, now));
    return 0;
  }
  const rawLimit = Number.parseInt(values.limit ?? "20", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 20;
  const all = await resumeAll(deps, live ?? new Map(), limit);
  const withLive = live !== undefined ? all.map((i) => ({ ...i, live: i.live ?? { running: 0, waitingPermission: 0 } })) : all;
  if (values.json === true) {
    io.out(`${JSON.stringify({ projects: withLive, daemon: live !== undefined }, null, 2)}\n`);
    return 0;
  }
  if (withLive.length === 0) {
    io.out("No recent projects. Open one with `ruah app <repo>`.\n");
    return 0;
  }
  io.out(`${withLive.map((i) => formatResumeShort(i, now)).join("")}${live === undefined ? "(no daemon running: live turn counts are not shown)\n" : ""}`);
  return 0;
}
