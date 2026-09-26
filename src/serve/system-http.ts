// src/serve/system-http.ts — CONTRACTS §12: multi-repo systems management
// over HTTP. A thin layer over the standalone library in src/system/*
// (manage, status, github, suggestions) plus the two things only the daemon
// has: the open system's live store (changes are saved through it and
// broadcast as `architecture`) and the current agent ("Suggest connections"
// runs as a normal turn via SessionHub.runTaskTurn). Every endpoint answers
// 409 unless a system project is open — except POST /api/system/create and
// the GitHub helpers. Every request passes the Origin check of /ws (403),
// POST bodies are JSON (≤ 64 KiB) validated by src/contracts/system.ts.
import * as fs from "node:fs";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProjectInfo } from "../contracts/ws.js";
import {
  AddRepoBodySchema,
  CloneBodySchema,
  CreateSystemBodySchema,
  RenameRepoBodySchema,
  RepoIdBodySchema,
  RunSuggestionsBodySchema,
  SuggestionIdBodySchema,
} from "../contracts/system.js";
import type { Runner } from "../integrations/exec.js";
import { ProjectError, type ProjectService } from "../projects/service.js";
import type { ArchitectureStore } from "./architecture-store.js";
import { parseBody, sendJson } from "./projects-http.js";
import type { PendingPermission, TaskTurn } from "./session.js";
import { systemHandleFor, type SystemHandle } from "../system/open.js";
import {
  acceptPending,
  addRepos,
  cloneGithubRepo,
  crossRepoSignalEdges,
  initSystem,
  listGithubRepos,
  livePending,
  readSuggestionsFile,
  recordSuggestionRun,
  rejectPending,
  removeRepo,
  renameRepo,
  runSuggestPass,
  SystemFileError,
  SystemManageError,
  systemStatus,
  unreject,
  type RunAgent,
  type SystemStatus,
} from "../system/index.js";

/** What the service needs from the SessionHub. */
export interface SystemHost {
  project(): ProjectInfo | null;
  readonly store: ArchitectureStore | null;
  agentId(): string;
  runTaskTurn(task: { text: string; prompt: string }): TaskTurn;
  /** A turn of the project that is running or queued (rename waits for it). */
  runningTurn(projectId: string): { turnId: string; text: string } | undefined;
  /** Permission requests the turn waits on. */
  pendingPermissionsForTurn(turnId: string): PendingPermission[];
  cancelTurn(turnId: string): Promise<void>;
}

/** Default upper bound on one "Suggest connections" run (RUAH_SUGGEST_TIMEOUT_MS overrides). */
export const DEFAULT_SUGGEST_TIMEOUT_MS = 10 * 60_000;

export interface SystemServiceDeps {
  host: SystemHost;
  /** Opens a created system as the current project. */
  projects?: ProjectService;
  version: string;
  /** The Ruah home (~/.ruah): a repo rename also rewrites the system's chats and cloud links there. */
  home?: string;
  /** Chat header cache to drop after a rename rewrote the chat files. */
  chats?: { reload(projectId: string): void };
  /** git runner (tests); default execFile. */
  runner?: Runner;
  /** gh runner (tests); default execFile. */
  ghRunner?: Runner;
  /** Upper bound on one "Suggest connections" run; default RUAH_SUGGEST_TIMEOUT_MS, else 10 min. */
  suggestTimeoutMs?: number;
}

/** The running "Suggest connections" pass, as the viewer sees it. */
export interface RunningSuggestions {
  startedAt: string;
  agentId: string;
  /** The agent turn (cancel it with POST …/suggestions/cancel). */
  turnId?: string;
  /** When the run is stopped if it has not finished (ISO). */
  deadline: string;
  /** What the agent waits for you to allow (answer it in the dialog or the chat); absent when nothing. */
  waitingPermission?: PendingPermission;
}

export interface SuggestionsView {
  pending: ReturnType<typeof livePending>;
  rejected: ReturnType<typeof readSuggestionsFile>["rejected"];
  lastRun: ReturnType<typeof readSuggestionsFile>["lastRun"] | null;
  running: RunningSuggestions | null;
}

interface RunState {
  startedAt: string;
  agentId: string;
  turnId?: string;
  deadline: number;
  /** Ends the run now with this error (cancel, timeout); the agent turn is cancelled. */
  stop?: (reason: string) => void;
  /** Settles once the run is over and recorded. */
  settled?: Promise<void>;
}

function suggestTimeoutFromEnv(): number {
  const raw = Number.parseInt(process.env.RUAH_SUGGEST_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 1000 ? raw : DEFAULT_SUGGEST_TIMEOUT_MS;
}

function minutes(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;
}

function toProjectError(err: unknown): unknown {
  if (err instanceof SystemManageError) {
    return new ProjectError(err.kind === "not_found" ? 404 : err.kind === "conflict" ? 409 : 400, err.message);
  }
  if (err instanceof SystemFileError) return new ProjectError(422, err.message);
  return err;
}

export class SystemService {
  private readonly running = new Map<string, RunState>();

  constructor(private readonly deps: SystemServiceDeps) {}

  /** The open system's handle; 409 when none is open. */
  current(): SystemHandle {
    const info = this.deps.host.project();
    if (info === null) throw new ProjectError(409, "no project open");
    if (info.kind !== "system") throw new ProjectError(409, "the open project is not a multi-repo system");
    const handle = systemHandleFor(info.root);
    if (handle === undefined) throw new ProjectError(409, "the open system is not loaded");
    return handle;
  }

  isSystemOpen(): boolean {
    const info = this.deps.host.project();
    return info !== null && info.kind === "system" && systemHandleFor(info.root) !== undefined;
  }

  async status(handle: SystemHandle = this.current()): Promise<SystemStatus> {
    return systemStatus(handle.system(), {
      architecture: handle.store.current(),
      ...(this.deps.runner !== undefined ? { runner: this.deps.runner } : {}),
    });
  }

  /** POST /api/system/create: writes (or extends) ruah.system.json, then opens it (default). */
  async create(body: { dir: string; name?: string | undefined; repos: { path: string; id?: string | undefined }[]; open?: boolean | undefined }): Promise<{
    project: ProjectInfo | null;
    created: boolean;
    added: string[];
    dir: string;
  }> {
    const result = initSystem(body.dir, { name: body.name, repos: body.repos, merge: true });
    const dir = result.system.dir;
    const open = this.deps.host.project();
    // Opened projects have real paths (/private/tmp on macOS); the dialog may name a symlinked one.
    if (open !== null && open.kind === "system" && (open.root === dir || open.root === realOrSame(dir))) {
      await systemHandleFor(open.root)?.reload();
      return { project: open, created: result.created, added: result.added.map((r) => r.id), dir };
    }
    let project: ProjectInfo | null = null;
    if (body.open !== false) {
      if (this.deps.projects === undefined) throw new ProjectError(503, "projects are not available");
      project = (await this.deps.projects.open(dir)).project;
    }
    return { project, created: result.created, added: result.added.map((r) => r.id), dir };
  }

  async addRepo(body: { path?: string | undefined; github?: { repo: string; parentDir?: string | undefined } | undefined; id?: string | undefined }): Promise<SystemStatus> {
    const handle = this.current();
    let repoPath = body.path;
    if (body.github !== undefined) {
      const parent = body.github.parentDir ?? path.dirname(handle.dir);
      repoPath = await cloneGithubRepo(body.github.repo, parent, this.deps.ghRunner !== undefined ? { runner: this.deps.ghRunner } : {});
    }
    if (repoPath === undefined) throw new ProjectError(400, "give either path or github");
    addRepos(handle.dir, [{ path: repoPath, id: body.id }]);
    await handle.reload();
    return this.status(handle);
  }

  async removeRepo(id: string): Promise<SystemStatus> {
    const handle = this.current();
    removeRepo(handle.dir, id);
    await handle.reload();
    return this.status(handle);
  }

  async renameRepo(id: string, newId: string): Promise<SystemStatus> {
    const handle = this.current();
    if (this.running.has(handle.dir)) throw new ProjectError(409, "Suggest connections is running; rename when it has finished");
    // A running turn stores its record (element ids included) when it finishes: after the rename
    // rewrote the chats, that would bring the old ids back. So wait for it (or stop it).
    const project = this.deps.host.project();
    const turn = project !== null ? this.deps.host.runningTurn(project.id) : undefined;
    if (turn !== undefined) {
      throw new ProjectError(409, "An agent turn is running in this system. Rename the repo when it has finished (or stop it): the turn would save the old ids back into its chat.");
    }
    renameRepo(handle.dir, id, newId, this.deps.home !== undefined ? { home: this.deps.home } : {});
    const info = this.deps.host.project();
    if (info !== null) this.deps.chats?.reload(info.id);
    await handle.reload();
    return this.status(handle);
  }

  async rescan(id?: string): Promise<{ status: SystemStatus; nodes: number; edges: number; ms: number }> {
    const handle = this.current();
    const started = Date.now();
    const result = await handle.reload(id !== undefined ? { rescan: id } : {});
    return { status: await this.status(handle), nodes: result.architecture.nodes.length, edges: result.architecture.edges.length, ms: Date.now() - started };
  }

  signals(): { edges: ReturnType<typeof crossRepoSignalEdges> } {
    const arch = this.current().store.current();
    return { edges: arch === null ? [] : crossRepoSignalEdges(arch) };
  }

  suggestions(handle: SystemHandle = this.current()): SuggestionsView {
    const file = readSuggestionsFile(handle.dir);
    return {
      pending: livePending(file, handle.store.current()),
      rejected: file.rejected,
      lastRun: file.lastRun ?? null,
      running: this.runningView(handle.dir),
    };
  }

  private runningView(dir: string): RunningSuggestions | null {
    const state = this.running.get(dir);
    if (state === undefined) return null;
    const waiting = state.turnId !== undefined ? this.deps.host.pendingPermissionsForTurn(state.turnId)[0] : undefined;
    return {
      startedAt: state.startedAt,
      agentId: state.agentId,
      ...(state.turnId !== undefined ? { turnId: state.turnId } : {}),
      deadline: new Date(state.deadline).toISOString(),
      ...(waiting !== undefined ? { waitingPermission: waiting } : {}),
    };
  }

  /**
   * POST /api/system/suggestions/cancel: stops the running pass at once (its
   * agent turn is cancelled; lastRun records it). 409 when nothing runs.
   */
  async cancelSuggestions(): Promise<SuggestionsView> {
    const handle = this.current();
    const state = this.running.get(handle.dir);
    if (state === undefined) throw new ProjectError(409, "Suggest connections is not running");
    state.stop?.("cancelled");
    await state.settled;
    return this.suggestions(handle);
  }

  /**
   * Starts "Suggest connections" on the current agent: a normal turn in the
   * active chat. Answers at once (202); the proposals land in
   * .ruah/suggestions.json when the turn finishes (poll GET suggestions, or
   * watch turn.finished). 409 when a run is going or the agent is busy.
   */
  runSuggestions(opts: { minConfidence?: number | undefined; maxSuggestions?: number | undefined } = {}): SuggestionsView {
    const handle = this.current();
    if (this.running.has(handle.dir)) throw new ProjectError(409, "Suggest connections is already running");
    const sys = handle.system();
    if (sys.repos.length < 2) throw new ProjectError(409, "add at least two repos before suggesting connections");
    const host = this.deps.host;
    const agentId = host.agentId();
    const timeoutMs = this.deps.suggestTimeoutMs ?? suggestTimeoutFromEnv();
    const state: RunState = { startedAt: new Date().toISOString(), agentId, deadline: Date.now() + timeoutMs };
    let startError: unknown;
    const runAgent: RunAgent = (prompt) => {
      let task: TaskTurn;
      try {
        task = host.runTaskTurn({ text: `Suggest connections between the ${sys.repos.length} repos of ${sys.name}`, prompt });
      } catch (err) {
        startError = err;
        throw err;
      }
      state.turnId = task.turnId;
      return new Promise<string>((resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          delete state.stop;
          fn();
        };
        // Stopping does not wait for the agent: the run ends now, the turn is cancelled behind it.
        const stop = (reason: string): void =>
          finish(() => {
            host.cancelTurn(task.turnId).catch(() => {});
            reject(new Error(reason));
          });
        const timer = setTimeout(() => {
          const waiting = host.pendingPermissionsForTurn(task.turnId)[0];
          stop(
            waiting !== undefined
              ? `timed out after ${minutes(timeoutMs)} waiting for your permission (${waiting.toolCall.title})`
              : `timed out after ${minutes(timeoutMs)}`,
          );
        }, timeoutMs);
        timer.unref?.();
        state.stop = stop;
        task.result.then(
          (r) =>
            finish(() => {
              if (r.stopReason !== "end_turn") reject(new Error(`the agent stopped (${r.stopReason})${r.error !== undefined ? `: ${r.error}` : ""}`));
              else resolve(r.text);
            }),
          (err: unknown) => finish(() => reject(err instanceof Error ? err : new Error(String(err)))),
        );
      });
    };
    this.running.set(handle.dir, state);
    // runAgent is called synchronously inside runSuggestPass (before its first await): a busy agent is known here.
    const pass = runSuggestPass(sys, runAgent, {
      agentId,
      architecture: handle.store.current(),
      version: handle.version,
      ...(opts.minConfidence !== undefined ? { minConfidence: opts.minConfidence } : {}),
      ...(opts.maxSuggestions !== undefined ? { maxSuggestions: opts.maxSuggestions } : {}),
    });
    const done = (): void => {
      if (this.running.get(handle.dir) === state) this.running.delete(handle.dir);
    };
    if (startError !== undefined) {
      done();
      pass.catch(() => {});
      throw new ProjectError(409, startError instanceof Error ? startError.message : String(startError));
    }
    state.settled = pass.then(done, (err: unknown) => {
      done();
      try {
        recordSuggestionRun(handle.dir, [], { agentId, error: err instanceof Error ? err.message : String(err) });
      } catch {
        // the system folder went away; nothing to record
      }
    });
    return this.suggestions(handle);
  }

  /** Waits for the running pass of the open system (tests, CLI-like callers). */
  async settle(timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (this.isSystemOpen() && this.running.has(this.current().dir)) {
      if (Date.now() - start > timeoutMs) throw new Error("suggestions still running");
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async accept(id: string): Promise<{ edge: unknown; suggestions: SuggestionsView }> {
    const handle = this.current();
    const arch = handle.store.current();
    if (arch === null) throw new ProjectError(503, "architecture not loaded");
    let accepted;
    try {
      accepted = acceptPending(handle.dir, arch, id);
    } catch (err) {
      throw new ProjectError(/unknown suggestion/.test((err as Error).message) ? 404 : 422, (err as Error).message);
    }
    await handle.store.save(accepted.architecture, { by: { kind: "user" } });
    return { edge: accepted.edge, suggestions: this.suggestions(handle) };
  }

  reject(id: string): SuggestionsView {
    const handle = this.current();
    try {
      rejectPending(handle.dir, id);
    } catch (err) {
      throw new ProjectError(404, (err as Error).message);
    }
    return this.suggestions(handle);
  }

  unreject(id: string): SuggestionsView {
    const handle = this.current();
    if (!unreject(handle.dir, id)) throw new ProjectError(404, `not rejected: ${id}`);
    return this.suggestions(handle);
  }

  githubRepos(owner: string | undefined, limit: number | undefined) {
    return listGithubRepos(owner, {
      ...(this.deps.ghRunner !== undefined ? { runner: this.deps.ghRunner } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  }

  clone(repo: string, parentDir: string): Promise<string> {
    return cloneGithubRepo(repo, parentDir, this.deps.ghRunner !== undefined ? { runner: this.deps.ghRunner } : {});
  }
}

function realOrSame(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

function fail(res: ServerResponse, err: unknown): void {
  const e = toProjectError(err);
  if (e instanceof ProjectError) {
    sendJson(res, e.status, { error: e.message });
    return;
  }
  sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
}

export function isSystemPath(pathname: string): boolean {
  return pathname === "/api/system" || pathname.startsWith("/api/system/");
}

/**
 * Handles /api/system/* (true), and POST /api/rescan when the open project
 * is a system (a single-repo rescan would scan the system folder itself).
 * Anything else: false.
 */
export function handleSystemRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  service: SystemService | undefined,
  originOk: (origin: string | undefined) => boolean,
): boolean {
  const { pathname } = url;
  const rescanOfSystem = pathname === "/api/rescan" && req.method === "POST" && service?.isSystemOpen() === true;
  if (!isSystemPath(pathname) && !rescanOfSystem) return false;
  if (service === undefined) {
    sendJson(res, 503, { error: "multi-repo systems are not available" });
    return true;
  }
  if (!originOk(req.headers.origin)) {
    sendJson(res, 403, { error: "origin not allowed" });
    return true;
  }
  const run = async (): Promise<void> => {
    if (rescanOfSystem) {
      const r = await service.rescan();
      sendJson(res, 200, { ok: true, nodes: r.nodes, edges: r.edges, ms: r.ms });
      return;
    }
    if (req.method === "GET") {
      switch (pathname) {
        case "/api/system":
          sendJson(res, 200, await service.status());
          return;
        case "/api/system/signals":
          sendJson(res, 200, service.signals());
          return;
        case "/api/system/suggestions":
          sendJson(res, 200, service.suggestions());
          return;
        case "/api/system/github/repos": {
          const owner = url.searchParams.get("owner") ?? undefined;
          const raw = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
          sendJson(res, 200, { repos: await service.githubRepos(owner, Number.isFinite(raw) ? raw : undefined) });
          return;
        }
        default:
          sendJson(res, 404, { error: "not found" });
          return;
      }
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    switch (pathname) {
      case "/api/system/create": {
        const body = await parseBody(req, CreateSystemBodySchema);
        sendJson(res, 200, await service.create(body));
        return;
      }
      case "/api/system/repos/add": {
        const body = await parseBody(req, AddRepoBodySchema);
        sendJson(res, 200, await service.addRepo(body));
        return;
      }
      case "/api/system/repos/remove": {
        const body = await parseBody(req, RepoIdBodySchema);
        sendJson(res, 200, await service.removeRepo(body.id));
        return;
      }
      case "/api/system/repos/rename": {
        const body = await parseBody(req, RenameRepoBodySchema);
        sendJson(res, 200, await service.renameRepo(body.id, body.newId));
        return;
      }
      case "/api/system/repos/rescan": {
        const body = await parseBody(req, RepoIdBodySchema);
        sendJson(res, 200, await service.rescan(body.id));
        return;
      }
      case "/api/system/rescan": {
        sendJson(res, 200, await service.rescan());
        return;
      }
      case "/api/system/github/clone": {
        const body = await parseBody(req, CloneBodySchema);
        sendJson(res, 200, { path: await service.clone(body.repo, body.parentDir) });
        return;
      }
      case "/api/system/suggestions/run": {
        const body = await parseBody(req, RunSuggestionsBodySchema);
        sendJson(res, 202, service.runSuggestions(body));
        return;
      }
      case "/api/system/suggestions/cancel": {
        sendJson(res, 200, await service.cancelSuggestions());
        return;
      }
      case "/api/system/suggestions/accept": {
        const body = await parseBody(req, SuggestionIdBodySchema);
        sendJson(res, 200, await service.accept(body.id));
        return;
      }
      case "/api/system/suggestions/reject": {
        const body = await parseBody(req, SuggestionIdBodySchema);
        sendJson(res, 200, service.reject(body.id));
        return;
      }
      case "/api/system/suggestions/unreject": {
        const body = await parseBody(req, SuggestionIdBodySchema);
        sendJson(res, 200, service.unreject(body.id));
        return;
      }
      default:
        sendJson(res, 404, { error: "not found" });
    }
  };
  run().catch((err: unknown) => fail(res, err));
  return true;
}
