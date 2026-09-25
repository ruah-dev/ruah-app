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
import type { TaskTurnResult } from "./session.js";
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
  runTaskTurn(task: { text: string; prompt: string }): Promise<TaskTurnResult>;
}

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
}

export interface SuggestionsView {
  pending: ReturnType<typeof livePending>;
  rejected: ReturnType<typeof readSuggestionsFile>["rejected"];
  lastRun: ReturnType<typeof readSuggestionsFile>["lastRun"] | null;
  running: { startedAt: string; agentId: string } | null;
}

function toProjectError(err: unknown): unknown {
  if (err instanceof SystemManageError) {
    return new ProjectError(err.kind === "not_found" ? 404 : err.kind === "conflict" ? 409 : 400, err.message);
  }
  if (err instanceof SystemFileError) return new ProjectError(422, err.message);
  return err;
}

export class SystemService {
  private readonly running = new Map<string, { startedAt: string; agentId: string }>();

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
      running: this.running.get(handle.dir) ?? null,
    };
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
    let startError: unknown;
    const runAgent: RunAgent = (prompt) => {
      let turn: Promise<TaskTurnResult>;
      try {
        turn = host.runTaskTurn({ text: `Suggest connections between the ${sys.repos.length} repos of ${sys.name}`, prompt });
      } catch (err) {
        startError = err;
        throw err;
      }
      return turn.then((r) => {
        if (r.stopReason !== "end_turn") throw new Error(`the agent stopped (${r.stopReason})${r.error !== undefined ? `: ${r.error}` : ""}`);
        return r.text;
      });
    };
    const state = { startedAt: new Date().toISOString(), agentId };
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
    pass.then(done, (err: unknown) => {
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
