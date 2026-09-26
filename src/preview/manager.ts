// The live preview's process manager (CONTRACTS §18): at most one dev server
// per project, run as a managed process — a "preview" tab in the terminal panel
// when node-pty loads (PtyRunner), else a plain child process — or the built-in
// static server. State machine stopped → starting → running | crashed; the URL
// comes from the server's output (url.ts), else from probing the ports it was
// expected to open; a health check (probe.ts) decides "running" and whether the
// page may be framed. Status changes are pushed through `onStatus` (the daemon
// broadcasts them as `preview` frames). A project's server is stopped once the
// project has not been open for `idleMs`, and every server when the daemon exits.
// A stop closes the server's terminal tab; a crash leaves it (its output) until
// the next start or stop, so restarts never pile up exited tabs.
import * as fs from "node:fs";
import * as path from "node:path";
import type { PreviewCandidate, PreviewDetection, PreviewStartBody, PreviewStatus } from "../contracts/preview.js";
import type { TerminalManager } from "../terminal/manager.js";
import { localPreviewFileOf, writeLocalPreviewChoice, writePreviewChoice, type PreviewChoicePatch } from "./config.js";
import { ruahHome } from "../usage/log.js";
import { customCandidate, detectPreview } from "./detect.js";
import { checkHttp as defaultCheckHttp, findFreePort, isPortOpen, type HttpCheck } from "./probe.js";
import { ProcessRunner, PtyRunner, type RunningProcess, type Runner } from "./runner.js";
import { previewEnv } from "./shell-env.js";
import { startStaticServer, type StaticServer } from "./static-server.js";
import { LineSplitter, cleanLogLine, crashReason, findUrls } from "./url.js";

export const DEFAULT_PREVIEW_IDLE_MS = 10 * 60 * 1000;
export const PREVIEW_LOG_LINES = 500;
export const STATUS_LOG_LINES = 40;

export interface PreviewProject {
  id: string;
  name: string;
  root: string;
  /** Multi-repo system (§12): "<repoId>/<rel>" folders resolve into these. */
  repos?: readonly { id: string; root: string }[];
}

export class PreviewError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detection?: PreviewDetection,
  ) {
    super(message);
  }
}

export interface PreviewTiming {
  /** No URL printed after this long: probe the expected ports. */
  probeAfterMs: number;
  probeEveryMs: number;
  /** Health checks while starting (fast) and while running. */
  startCheckMs: number;
  healthEveryMs: number;
  /** Ctrl+C → wait → hang up → wait. */
  stopGraceMs: number;
  /** The wait after Ctrl+C for `docker compose up`: it stops the containers first (up to 10 s each). */
  composeStopGraceMs: number;
  /** A fixed URL (.ruah/preview.json) that has not answered this long gets a hint in the log. */
  fixedUrlHintMs: number;
  /** Log-only status pushes at most this often. */
  broadcastMs: number;
}

const DEFAULT_TIMING: PreviewTiming = {
  probeAfterMs: 2500,
  probeEveryMs: 1000,
  startCheckMs: 400,
  healthEveryMs: 5000,
  stopGraceMs: 3000,
  composeStopGraceMs: 12_000,
  fixedUrlHintMs: 30_000,
  broadcastMs: 250,
};

export interface PreviewManagerOptions {
  /** The project open right now (null: launcher). */
  project: () => PreviewProject | null;
  version: string;
  /** The daemon's terminal manager: dev servers become "preview" tabs (PTY). Absent → plain processes. */
  terminals?: TerminalManager;
  /** Environment of dev servers (default: the user's shell environment, shell-env.ts). */
  env?: (project: PreviewProject) => Promise<Record<string, string>>;
  onStatus?: (status: PreviewStatus) => void;
  /** Stop a project's server after it has not been the open project this long (RUAH_PREVIEW_IDLE_MS; 0 = at the next sweep). */
  idleMs?: number;
  /** Periodic idle sweep (default on; tests call sweep()). */
  sweep?: boolean;
  now?: () => number;
  /** PATH for "is pnpm installed" in detection (default: process.env.PATH). */
  pathEnv?: () => string | undefined;
  timing?: Partial<PreviewTiming>;
  /** Runner override (tests, the CLI's foreground mode). */
  runner?: Runner;
  checkHttp?: (url: string, timeoutMs?: number) => Promise<HttpCheck>;
  /**
   * Where a project's choice is remembered on this computer (§21.3; default
   * `$RUAH_HOME/projects/<id>/preview.json`). The repo's `.ruah/preview.json`
   * is written only on an explicit `saveToRepo`.
   */
  localChoiceFile?: (project: PreviewProject) => string;
}

interface Entry {
  project: PreviewProject;
  status: PreviewStatus;
  proc: RunningProcess | undefined;
  /** A crashed process whose terminal tab still shows its output: closed at the next start / stop. */
  leftover: RunningProcess | undefined;
  staticServer: StaticServer | undefined;
  logs: string[];
  splitter: LineSplitter;
  generation: number;
  stopRequested: boolean;
  urlScore: number;
  fixedUrl: string | undefined;
  openBefore: Set<number>;
  probePorts: number[];
  timers: Set<NodeJS.Timeout>;
  healthTimer: NodeJS.Timeout | undefined;
  checking: boolean;
  closedSince: number | undefined;
  exitWaiters: (() => void)[];
  emitTimer: NodeJS.Timeout | undefined;
}

function emptyStatus(project: PreviewProject): PreviewStatus {
  return {
    projectId: project.id,
    root: project.root,
    rev: 0,
    state: "stopped",
    candidate: null,
    command: null,
    cwd: null,
    url: null,
    port: null,
    healthy: false,
    framing: "unknown",
    hmr: false,
    runner: null,
    terminalId: null,
    pid: null,
    startedAt: null,
    exitCode: null,
    signal: null,
    logs: [],
  };
}

function inside(child: string, root: string): boolean {
  return child === root || child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

export class PreviewManager {
  private readonly entries = new Map<string, Entry>();
  private readonly timing: PreviewTiming;
  private readonly now: () => number;
  private readonly sweepTimer: NodeJS.Timeout | undefined;
  private readonly processRunner = new ProcessRunner();
  private closing = false;
  /** Status revisions start at the clock so a restarted daemon's pushes outrank the old one's. */
  private rev = Date.now();
  /** PATH of the dev servers' environment, once read (detection's "is pnpm installed"). */
  private shellPath: string | undefined;

  constructor(private readonly options: PreviewManagerOptions) {
    this.timing = { ...DEFAULT_TIMING, ...(options.timing ?? {}) };
    this.now = options.now ?? Date.now;
    if (options.sweep !== false) {
      this.sweepTimer = setInterval(() => void this.sweep(), 2000);
      this.sweepTimer.unref();
    }
  }

  // ------------------------------------------------------------ reads

  currentProject(): PreviewProject | null {
    return this.options.project();
  }

  /** The open project's preview (state "stopped" when it never ran); null in the launcher state. */
  status(projectId?: string): PreviewStatus | null {
    const project = this.options.project();
    const id = projectId ?? project?.id;
    if (id === undefined) return null;
    const entry = this.entries.get(id);
    if (entry !== undefined) return this.snapshot(entry);
    return project !== null && project.id === id ? emptyStatus(project) : null;
  }

  /** Every project with a preview process (running, starting) — the idle sweep's view. */
  live(): PreviewStatus[] {
    return [...this.entries.values()].filter((e) => this.isLive(e)).map((e) => this.snapshot(e));
  }

  logs(projectId?: string, lines = PREVIEW_LOG_LINES): string[] {
    const id = projectId ?? this.options.project()?.id;
    const entry = id !== undefined ? this.entries.get(id) : undefined;
    return entry === undefined ? [] : entry.logs.slice(-Math.max(1, Math.min(PREVIEW_LOG_LINES, lines)));
  }

  /** Detection with the PATH known so far (the daemon's until the shell environment is read). */
  detect(project: PreviewProject | null = this.options.project(), pathEnv?: string): PreviewDetection {
    if (project === null) throw new PreviewError(409, "open a project first");
    return detectPreview(project.root, {
      pathEnv: pathEnv ?? this.options.pathEnv?.() ?? this.shellPath ?? process.env.PATH,
      ...(project.repos !== undefined ? { repos: project.repos } : {}),
      localChoiceFile: this.localChoiceFile(project),
    });
  }

  private localChoiceFile(project: PreviewProject): string {
    return this.options.localChoiceFile?.(project) ?? localPreviewFileOf(ruahHome(), project.id);
  }

  /**
   * Remembers a choice: on this computer by default; with `saveToRepo` in the
   * repo's `.ruah/preview.json` (and this computer's copy is dropped, so the
   * saved one applies). 409 on an invalid repo file.
   */
  private remember(project: PreviewProject, patch: PreviewChoicePatch, saveToRepo: boolean): void {
    try {
      if (saveToRepo) {
        writePreviewChoice(project.root, patch);
        writeLocalPreviewChoice(this.localChoiceFile(project), { candidate: null, command: null, url: null });
      } else {
        writeLocalPreviewChoice(this.localChoiceFile(project), patch);
      }
    } catch (err) {
      throw new PreviewError(409, err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Detection with the dev servers' PATH (the user's shell environment, read once): Ruah
   * started from the Dock only has the system PATH, which would call pnpm or python3 missing.
   */
  async detectFresh(project: PreviewProject | null = this.options.project()): Promise<PreviewDetection> {
    if (project === null) throw new PreviewError(409, "open a project first");
    if (this.options.pathEnv === undefined && this.shellPath === undefined) {
      this.shellPath = await this.envFor(project).then(
        (env) => env.PATH,
        () => undefined,
      );
    }
    return this.detect(project);
  }

  // ------------------------------------------------------------ actions

  /**
   * Saves the project's choice: on this computer, or with `saveToRepo` in
   * `.ruah/preview.json` (a command needs `allowCommand`).
   */
  choose(patch: PreviewChoicePatch & { saveToRepo?: boolean | undefined }, opts: { allowCommand?: boolean } = {}): PreviewDetection {
    const project = this.requireProject();
    const { saveToRepo, ...choice } = patch;
    if (typeof choice.command === "string" && opts.allowCommand !== true) throw new PreviewError(403, "a custom command needs the terminal token");
    if (typeof choice.candidate === "string") {
      const detection = this.detect(project);
      if (!detection.candidates.some((c) => c.id === choice.candidate && c.kind !== "custom")) throw new PreviewError(404, `unknown candidate "${choice.candidate}"`, detection);
    }
    this.remember(project, choice, saveToRepo === true);
    return this.detect(project);
  }

  /**
   * Starts the open project's dev server: a candidate id, your own command
   * (`allowCommand`), else the saved choice / the obvious candidate (409 with
   * the detection when the user has to pick). Already running the same thing:
   * returns its status; something else: stops it first.
   */
  async start(body: PreviewStartBody = {}, opts: { allowCommand?: boolean } = {}): Promise<PreviewStatus> {
    if (this.closing) throw new PreviewError(503, "the daemon is shutting down");
    const project = this.requireProject();
    const detection = await this.detectFresh(project);
    let candidate: PreviewCandidate;
    if (body.command !== undefined) {
      if (opts.allowCommand !== true) throw new PreviewError(403, "a custom command needs the terminal token");
      candidate = customCandidate({ command: body.command, dir: body.dir ?? "." }, "your command");
    } else if (body.candidate !== undefined) {
      const hit = detection.candidates.find((c) => c.id === body.candidate);
      if (hit === undefined) throw new PreviewError(404, `unknown candidate "${body.candidate}"`, detection);
      candidate = hit;
    } else {
      const hit = detection.candidates.find((c) => c.id === detection.selected);
      if (hit === undefined) {
        throw new PreviewError(
          409,
          detection.candidates.length === 0 ? "no dev server found in this project — add a command" : "pick what to run (the project has several apps)",
          detection,
        );
      }
      candidate = hit;
    }
    if (body.remember === true || body.saveToRepo === true) {
      this.remember(project, candidate.kind === "custom" ? { command: candidate.command, dir: candidate.dir } : { candidate: candidate.id }, body.saveToRepo === true);
    }
    const entry = this.entryFor(project);
    const current = entry.status.candidate;
    if (this.isLive(entry) && current !== null && current.id === candidate.id && current.command === candidate.command && current.dir === candidate.dir) {
      return this.snapshot(entry);
    }
    if (this.isLive(entry)) await this.stopEntry(entry);
    return this.launch(entry, candidate, detection.choice?.url);
  }

  /** Stops the project's dev server (Ctrl+C, then hang up); a crashed preview goes back to "stopped". */
  async stop(projectId?: string): Promise<PreviewStatus | null> {
    const id = projectId ?? this.options.project()?.id;
    if (id === undefined) throw new PreviewError(409, "open a project first");
    const entry = this.entries.get(id);
    if (entry === undefined) return this.status(id);
    await this.stopEntry(entry);
    return this.snapshot(entry);
  }

  /** Stops and starts the same command again (re-read from the project, so edits to package.json count). */
  async restart(): Promise<PreviewStatus> {
    const project = this.requireProject();
    const entry = this.entries.get(project.id);
    const previous = entry?.status.candidate ?? null;
    if (previous === null) return this.start();
    if (previous.kind === "custom") {
      if (entry !== undefined) await this.stopEntry(entry);
      const detection = this.detect(project);
      return this.launch(this.entryFor(project), previous, detection.choice?.url);
    }
    const detection = await this.detectFresh(project);
    const fresh = detection.candidates.find((c) => c.id === previous.id) ?? previous;
    if (entry !== undefined) await this.stopEntry(entry);
    return this.launch(this.entryFor(project), fresh, detection.choice?.url);
  }

  /** Stops the servers of projects that have not been open for idleMs. */
  async sweep(now = this.now()): Promise<void> {
    const current = this.options.project()?.id;
    const idleMs = this.options.idleMs ?? DEFAULT_PREVIEW_IDLE_MS;
    const stale: Entry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.project.id === current) {
        entry.closedSince = undefined;
        continue;
      }
      if (!this.isLive(entry)) continue;
      entry.closedSince ??= now;
      if (now - entry.closedSince >= idleMs) stale.push(entry);
    }
    await Promise.all(stale.map((e) => this.stopEntry(e).catch(() => {})));
  }

  /** Daemon exit: stop every server (Ctrl+C, short grace), close static servers. */
  async shutdownAll(graceMs = 1500): Promise<void> {
    this.closing = true;
    if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer);
    await Promise.all([...this.entries.values()].map((e) => this.stopEntry(e, graceMs).catch(() => {})));
  }

  /** Synchronous last resort (process "exit"): terminate plain child processes (PTYs are hung up by the terminal manager). */
  hangUpAll(): void {
    this.processRunner.killAll();
  }

  // ------------------------------------------------------------ internals

  private requireProject(): PreviewProject {
    const project = this.options.project();
    if (project === null) throw new PreviewError(409, "open a project first");
    return project;
  }

  private entryFor(project: PreviewProject): Entry {
    let entry = this.entries.get(project.id);
    if (entry === undefined) {
      entry = {
        project,
        status: emptyStatus(project),
        proc: undefined,
        leftover: undefined,
        staticServer: undefined,
        logs: [],
        splitter: new LineSplitter(),
        generation: 0,
        stopRequested: false,
        urlScore: Number.NEGATIVE_INFINITY,
        fixedUrl: undefined,
        openBefore: new Set(),
        probePorts: [],
        timers: new Set(),
        healthTimer: undefined,
        checking: false,
        closedSince: undefined,
        exitWaiters: [],
        emitTimer: undefined,
      };
      this.entries.set(project.id, entry);
    } else entry.project = project;
    return entry;
  }

  private isLive(entry: Entry): boolean {
    return entry.proc !== undefined || entry.staticServer !== undefined || entry.status.state === "starting";
  }

  private snapshot(entry: Entry): PreviewStatus {
    return { ...entry.status, logs: entry.logs.slice(-STATUS_LOG_LINES) };
  }

  private emit(entry: Entry, immediate = true): void {
    const send = (): void => {
      entry.emitTimer = undefined;
      this.rev += 1;
      entry.status = { ...entry.status, rev: this.rev };
      this.options.onStatus?.(this.snapshot(entry));
    };
    if (immediate) {
      if (entry.emitTimer !== undefined) clearTimeout(entry.emitTimer);
      send();
      return;
    }
    if (entry.emitTimer !== undefined) return;
    entry.emitTimer = setTimeout(send, this.timing.broadcastMs);
    entry.emitTimer.unref();
  }

  private later(entry: Entry, ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      entry.timers.delete(timer);
      fn();
    }, ms);
    timer.unref();
    entry.timers.add(timer);
  }

  private clearTimers(entry: Entry): void {
    for (const t of entry.timers) clearTimeout(t);
    entry.timers.clear();
    if (entry.healthTimer !== undefined) clearTimeout(entry.healthTimer);
    entry.healthTimer = undefined;
  }

  private appendLine(entry: Entry, raw: string): void {
    const line = cleanLogLine(raw);
    if (line.length === 0) return;
    entry.logs.push(line.length > 2000 ? `${line.slice(0, 2000)}…` : line);
    if (entry.logs.length > PREVIEW_LOG_LINES) entry.logs.splice(0, entry.logs.length - PREVIEW_LOG_LINES);
  }

  /** "<repoId>/<rel>" (systems), "." or a repo-relative folder → an existing absolute folder inside the project. */
  resolveDir(project: PreviewProject, dir: string): string {
    const clean = dir.replaceAll("\\", "/").replace(/\/+$/, "") || ".";
    if (clean.includes("\0") || path.isAbsolute(clean)) throw new PreviewError(400, "the folder must be relative to the project");
    const normalized = path.posix.normalize(clean);
    if (normalized === ".." || normalized.startsWith("../")) throw new PreviewError(400, "the folder is outside the project");
    let base = path.resolve(project.root);
    let rest = normalized;
    for (const repo of project.repos ?? []) {
      if (normalized === repo.id || normalized.startsWith(`${repo.id}/`)) {
        base = path.resolve(repo.root);
        rest = normalized === repo.id ? "." : normalized.slice(repo.id.length + 1);
        break;
      }
    }
    const abs = path.resolve(base, rest);
    if (!inside(abs, base)) throw new PreviewError(400, "the folder is outside the project");
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(abs);
    } catch {
      stat = undefined;
    }
    if (stat === undefined || !stat.isDirectory()) throw new PreviewError(404, `no folder "${dir}" in the project`);
    return abs;
  }

  private async runner(): Promise<Runner> {
    if (this.options.runner !== undefined) return this.options.runner;
    const terminals = this.options.terminals;
    if (terminals !== undefined && (await terminals.availability()).available) return new PtyRunner(terminals);
    return this.processRunner;
  }

  private async envFor(project: PreviewProject): Promise<Record<string, string>> {
    if (this.options.env !== undefined) return this.options.env(project);
    return previewEnv({ projectRoot: project.root, version: this.options.version });
  }

  /** Closes the terminal tab a crashed server left behind. */
  private closeLeftover(entry: Entry): void {
    const leftover = entry.leftover;
    entry.leftover = undefined;
    leftover?.close();
  }

  /** Tells the user when the fixed URL never answers (the preview would otherwise just keep "starting"). */
  private fixedUrlHint(entry: Entry, gen: number, url: string): void {
    this.later(entry, this.timing.fixedUrlHintMs, () => {
      if (gen !== entry.generation || entry.status.state !== "starting") return;
      this.appendLine(entry, `ruah: no answer from ${url} (the url in .ruah/preview.json) — is that where the dev server listens?`);
      this.emit(entry);
    });
  }

  private async launch(entry: Entry, candidate: PreviewCandidate, fixedUrl: string | undefined): Promise<PreviewStatus> {
    entry.generation += 1;
    const gen = entry.generation;
    this.clearTimers(entry);
    this.closeLeftover(entry);
    entry.logs = [];
    entry.splitter = new LineSplitter();
    entry.stopRequested = false;
    entry.urlScore = Number.NEGATIVE_INFINITY;
    entry.fixedUrl = fixedUrl;
    entry.closedSince = undefined;
    const project = entry.project;
    const base = emptyStatus(project);

    const fail = (message: string): PreviewStatus => {
      entry.status = { ...entry.status, state: "crashed", healthy: false, error: message };
      this.appendLine(entry, message);
      this.emit(entry);
      return this.snapshot(entry);
    };

    let cwd: string;
    try {
      cwd = this.resolveDir(project, candidate.dir);
    } catch (err) {
      entry.status = { ...base, candidate, command: candidate.command, hmr: candidate.hmr };
      return fail(err instanceof Error ? err.message : String(err));
    }
    const wantsPort = candidate.kind === "static" || candidate.command.includes("{port}") || Object.values(candidate.env ?? {}).some((v) => v.includes("{port}"));
    let port: number | null = null;
    if (wantsPort) {
      try {
        port = await findFreePort(candidate.port ?? 3000);
      } catch (err) {
        entry.status = { ...base, candidate, command: candidate.command, cwd, hmr: candidate.hmr };
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
    const fill = (text: string): string => (port === null ? text : text.replaceAll("{port}", String(port)));
    const command = fill(candidate.command);
    entry.status = {
      ...base,
      state: "starting",
      candidate,
      command: candidate.kind === "static" ? `built-in static server (${candidate.dir})` : command,
      cwd,
      port,
      hmr: candidate.hmr,
      startedAt: new Date(this.now()).toISOString(),
    };
    this.emit(entry);

    if (candidate.kind === "static") {
      try {
        const server = await startStaticServer({ dir: cwd, port: port ?? 0, log: (line) => this.appendLine(entry, line) });
        if (gen !== entry.generation) {
          await server.close();
          return this.snapshot(entry);
        }
        entry.staticServer = server;
        entry.status = { ...entry.status, runner: "static", url: fixedUrl ?? server.url, port: server.port, pid: null };
        this.emit(entry);
        this.healthLoop(entry, gen);
        if (fixedUrl !== undefined) this.fixedUrlHint(entry, gen, fixedUrl);
        return this.snapshot(entry);
      } catch (err) {
        return fail(`could not start the static server: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Ports the server may open, and which of them were taken before it started (never "ours").
    const expected = port ?? candidate.port;
    entry.probePorts = expected === undefined ? [] : port !== null ? [port] : [expected, expected + 1, expected + 2, expected + 3];
    const open = await Promise.all(entry.probePorts.map(async (p) => ((await isPortOpen(p, 250)) ? p : null)));
    entry.openBefore = new Set(open.filter((p): p is number => p !== null));

    let env: Record<string, string>;
    try {
      env = await this.envFor(project);
    } catch {
      env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
    }
    for (const [key, value] of Object.entries(candidate.env ?? {})) env[key] = fill(value);

    let runner = await this.runner();
    let proc: RunningProcess;
    const events = {
      onData: (text: string) => this.onData(entry, gen, text),
      onExit: (code: number | null, signal: number | null, closed?: boolean) => this.onExit(entry, gen, code, signal, closed === true),
    };
    const spec = { command, cwd, env, title: `preview · ${candidate.title}`.slice(0, 80) };
    try {
      proc = await runner.start(spec, events);
    } catch (err) {
      if (runner.kind === "pty" && this.options.runner === undefined) {
        // PTY refused (too many terminals, terminals closing): a plain process still works.
        runner = this.processRunner;
        try {
          proc = await runner.start(spec, events);
        } catch (err2) {
          return fail(`could not start: ${err2 instanceof Error ? err2.message : String(err2)}`);
        }
      } else return fail(`could not start: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (gen !== entry.generation) {
      proc.kill();
      return this.snapshot(entry);
    }
    if (entry.status.state === "crashed" || entry.status.state === "stopped") {
      // It exited while we were still wiring it up (onExit already ran).
      proc.dispose();
      if (entry.status.state === "crashed") entry.leftover = proc;
      else proc.close();
      return this.snapshot(entry);
    }
    entry.proc = proc;
    entry.status = { ...entry.status, runner: proc.kind, terminalId: proc.terminalId, pid: proc.pid };
    this.emit(entry);
    if (fixedUrl !== undefined) {
      entry.status = { ...entry.status, url: fixedUrl };
      entry.urlScore = Number.POSITIVE_INFINITY;
      this.healthLoop(entry, gen);
      this.fixedUrlHint(entry, gen, fixedUrl);
    } else {
      this.later(entry, this.timing.probeAfterMs, () => this.probeLoop(entry, gen));
    }
    return this.snapshot(entry);
  }

  private onData(entry: Entry, gen: number, text: string): void {
    if (gen !== entry.generation) return;
    for (const line of entry.splitter.push(text)) this.onLine(entry, gen, line);
    this.emit(entry, false);
  }

  private onLine(entry: Entry, gen: number, raw: string): void {
    this.appendLine(entry, raw);
    if (entry.status.state !== "starting" || entry.fixedUrl !== undefined) return;
    const best = findUrls(raw)[0];
    if (best === undefined || best.score <= entry.urlScore) return;
    entry.urlScore = best.score;
    entry.status = { ...entry.status, url: best.url, port: best.port };
    this.healthLoop(entry, gen);
  }

  private probeLoop(entry: Entry, gen: number): void {
    if (gen !== entry.generation || entry.status.state !== "starting" || entry.status.url !== null) return;
    const ports = entry.probePorts.filter((p) => !entry.openBefore.has(p));
    if (ports.length === 0) return;
    void (async () => {
      for (const p of ports) {
        if (await isPortOpen(p, 250)) {
          if (gen !== entry.generation || entry.status.url !== null) return;
          entry.urlScore = -1;
          entry.status = { ...entry.status, url: `http://localhost:${p}/`, port: p };
          this.healthLoop(entry, gen);
          return;
        }
      }
      this.later(entry, this.timing.probeEveryMs, () => this.probeLoop(entry, gen));
    })();
  }

  /** Checks the URL: fast while starting (→ running), slowly while running (healthy / framing). */
  private healthLoop(entry: Entry, gen: number): void {
    if (entry.healthTimer !== undefined || entry.checking) return;
    const check = async (): Promise<void> => {
      entry.healthTimer = undefined;
      if (gen !== entry.generation) return;
      const url = entry.status.url;
      if (url === null || (entry.status.state !== "starting" && entry.status.state !== "running")) return;
      entry.checking = true;
      const result = await (this.options.checkHttp ?? defaultCheckHttp)(url, 2000).catch((): HttpCheck => ({ ok: false, framing: "unknown" }));
      entry.checking = false;
      if (gen !== entry.generation || (entry.status.state !== "starting" && entry.status.state !== "running")) return;
      const before = entry.status;
      if (result.ok) {
        entry.status = { ...entry.status, state: "running", healthy: true, framing: result.framing };
      } else if (entry.status.state === "running") {
        entry.status = { ...entry.status, healthy: false };
      }
      if (before.state !== entry.status.state || before.healthy !== entry.status.healthy || before.framing !== entry.status.framing || before.url !== url) this.emit(entry);
      const delay = entry.status.state === "running" ? this.timing.healthEveryMs : this.timing.startCheckMs;
      entry.healthTimer = setTimeout(() => void check(), delay);
      entry.healthTimer.unref();
    };
    void check();
  }

  /** `closed`: the user closed the preview's terminal tab — a stop, not a crash. */
  private onExit(entry: Entry, gen: number, exitCode: number | null, signal: number | null, closed = false): void {
    if (gen !== entry.generation) return;
    for (const line of entry.splitter.flush()) this.appendLine(entry, line);
    this.clearTimers(entry);
    const proc = entry.proc;
    proc?.dispose();
    entry.proc = undefined;
    if (entry.stopRequested || this.closing || closed) {
      if (closed && !entry.stopRequested && !this.closing) this.appendLine(entry, "ruah: the preview's terminal tab was closed — the dev server stopped");
      // Its tab is closed (or was, by the user): the output stays in `logs`.
      entry.status = { ...entry.status, state: "stopped", healthy: false, exitCode, signal, pid: null, terminalId: null };
      delete entry.status.error;
      proc?.close();
    } else {
      entry.leftover = proc;
      const reason = crashReason(entry.logs);
      const how = exitCode !== null ? `exited with code ${exitCode}` : signal !== null ? `was stopped (signal ${signal})` : "exited";
      entry.status = { ...entry.status, state: "crashed", healthy: false, exitCode, signal, pid: null, error: reason !== undefined ? `The dev server ${how}: ${reason}` : `The dev server ${how}` };
    }
    this.emit(entry);
    for (const resolve of entry.exitWaiters.splice(0)) resolve();
  }

  private waitExit(entry: Entry, ms: number): Promise<boolean> {
    if (entry.proc === undefined) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(entry.proc === undefined), ms);
      timer.unref();
      entry.exitWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private async stopEntry(entry: Entry, graceMs = this.timing.stopGraceMs): Promise<void> {
    entry.stopRequested = true;
    this.clearTimers(entry);
    this.closeLeftover(entry);
    const server = entry.staticServer;
    if (server !== undefined) {
      entry.staticServer = undefined;
      await server.close().catch(() => {});
    }
    const proc = entry.proc;
    if (proc !== undefined) {
      proc.interrupt();
      // `docker compose up` stops its containers after Ctrl+C: hanging up earlier leaves them running.
      const interruptGrace = entry.status.candidate?.kind === "compose" ? Math.max(graceMs, this.timing.composeStopGraceMs) : graceMs;
      if (!(await this.waitExit(entry, interruptGrace))) {
        proc.kill();
        if (!(await this.waitExit(entry, graceMs))) {
          // Unresponsive: forget it (the PTY / process group was sent SIGKILL).
          proc.dispose();
          if (entry.proc === proc) entry.proc = undefined;
        }
      }
    }
    entry.generation += 1; // late events of the old process are ignored
    if (entry.status.state !== "stopped" || entry.status.error !== undefined || entry.status.terminalId !== null) {
      entry.status = { ...entry.status, state: "stopped", healthy: false, pid: null, terminalId: null };
      delete entry.status.error;
      this.emit(entry);
    }
  }
}
