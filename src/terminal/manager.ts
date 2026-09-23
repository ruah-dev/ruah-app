// Adapted from t3code apps/server/src/terminal/Manager.ts (MIT, eff44be43) — see THIRD_PARTY_NOTICES.md
//
// PTY sessions of the daemon (CONTRACTS §7). Each terminal belongs to the
// project that was open when it was created and survives viewer reloads and
// project switches: output is kept in a scrollback ring so a viewer
// re-attaches and replays. Terminals of a project that has not been the open
// project for `idleMs` (default 1 h) are killed, and every terminal is killed
// when the daemon exits. Effect-TS, persistence and subprocess inspection of
// the original are left out.
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import type { TerminalInfo, TerminalServerMessage } from "../contracts/terminal.js";
import { TerminalError, allowedRoots, resolveTerminalCwd, type TerminalProject } from "./cwd.js";
import { resolveShell, terminalEnv, type ShellCommand } from "./env.js";
import { ScrollbackBuffer, altScreenAfter } from "./history.js";
import { loadPty, type PtyLoadResult, type PtyProcess } from "./pty.js";

export { TerminalError, type TerminalProject } from "./cwd.js";

export const DEFAULT_SCROLLBACK_BYTES = 1024 * 1024;
export const DEFAULT_IDLE_MS = 60 * 60 * 1000;
const SWEEP_MS = 30_000;
const KILL_GRACE_MS = 2000;
// Flow control (as in VS Code's terminal): pause the PTY while a viewer is
// more than HIGH characters behind, resume once every viewer is under LOW.
export const FLOW_HIGH_WATERMARK = 100_000;
export const FLOW_LOW_WATERMARK = 5_000;
// "Run in terminal": type the command once the shell has drawn its prompt
// (first output, then this much quiet), at the latest after INITIAL_INPUT_MAX_MS.
const INITIAL_INPUT_QUIET_MS = 250;
const INITIAL_INPUT_MAX_MS = 4000;

export type TerminalSink = (message: TerminalServerMessage) => void;

export interface TerminalManagerOptions {
  /** The project open in the daemon right now (null: launcher state). */
  project: () => TerminalProject | null;
  version: string;
  loadPty?: () => Promise<PtyLoadResult>;
  env?: NodeJS.ProcessEnv;
  shell?: ShellCommand;
  scrollbackBytes?: number;
  /** Kill a project's terminals after it has not been open this long (RUAH_TERMINAL_IDLE_MS). */
  idleMs?: number;
  maxSessions?: number;
  now?: () => number;
  /** Periodic idle sweep (default on; tests call sweep() themselves). */
  sweep?: boolean;
}

interface Session {
  info: TerminalInfo;
  pty: PtyProcess | null;
  history: ScrollbackBuffer;
  sinks: Map<TerminalSink, { unacked: number }>;
  paused: boolean;
  altScreen: boolean;
  bracketedPaste: boolean;
  pendingInput?: { text: string; timer: NodeJS.Timeout | undefined; deadline: NodeJS.Timeout } | undefined;
  unsubscribe: (() => void)[];
  killTimer?: NodeJS.Timeout;
}

export interface CreateTerminalRequest {
  cwd?: string | undefined;
  nodeId?: string | undefined;
  cols: number;
  rows: number;
  title?: string | undefined;
  input?: string | undefined;
}

function modeAfter(current: boolean, data: string, mode: string): boolean {
  if (!data.includes(`\u001b[?${mode}`)) return current;
  const on = data.lastIndexOf(`\u001b[?${mode}h`);
  const off = data.lastIndexOf(`\u001b[?${mode}l`);
  return on === off ? current : on > off;
}

/** The command as typed text: bracketed paste when the shell asked for it (newlines stay literal), else one line. */
export function pastedCommand(text: string, bracketed: boolean): string {
  const trimmed = text.replace(/[\r\n]+$/, "");
  // Never let an embedded paste terminator end the bracket early.
  if (bracketed) return `\u001b[200~${trimmed.replaceAll("\u001b[201~", "")}\u001b[201~`;
  return trimmed.replace(/\r?\n/g, " ");
}

export class TerminalManager {
  private readonly sessions = new Map<string, Session>();
  private readonly listeners = new Set<(projectId: string) => void>();
  /** Last time each project with terminals was the open project. */
  private readonly lastOpen = new Map<string, number>();
  private readonly sweepTimer: NodeJS.Timeout | undefined;
  private readonly now: () => number;
  private closed = false;

  constructor(private readonly options: TerminalManagerOptions) {
    this.now = options.now ?? Date.now;
    if (options.sweep !== false) {
      this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS);
      this.sweepTimer.unref();
    }
  }

  /** node-pty loaded? The reason carries the fix when it did not. */
  async availability(): Promise<{ available: true; shell: string } | { available: false; reason: string }> {
    const loaded = await (this.options.loadPty ?? loadPty)();
    return loaded.ok ? { available: true, shell: this.shell().shell } : { available: false, reason: loaded.reason };
  }

  currentProjectId(): string | null {
    return this.options.project()?.id ?? null;
  }

  /** Notified with a project id whenever its terminal list changes (created, renamed, exited, killed). */
  onChange(listener: (projectId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(projectId: string | null = this.currentProjectId()): TerminalInfo[] {
    if (projectId === null) return [];
    return [...this.sessions.values()].filter((s) => s.info.projectId === projectId).map((s) => ({ ...s.info }));
  }

  async create(request: CreateTerminalRequest): Promise<TerminalInfo> {
    if (this.closed) throw new TerminalError("the daemon is shutting down", 503);
    const project = this.options.project();
    if (project === null) throw new TerminalError("open a project first", 409);
    const loaded = await (this.options.loadPty ?? loadPty)();
    if (!loaded.ok) throw new TerminalError(loaded.reason, 503);
    const max = this.options.maxSessions ?? 32;
    if (this.sessions.size >= max) throw new TerminalError(`too many terminals (${max}); close one first`, 429);
    const cwd = resolveTerminalCwd(project, { cwd: request.cwd, nodeId: request.nodeId });
    const shell = this.shell();
    let pty: PtyProcess;
    try {
      pty = loaded.backend.spawn({
        shell: shell.shell,
        args: shell.args,
        cwd,
        cols: request.cols,
        rows: request.rows,
        env: terminalEnv(this.options.env ?? process.env, { projectRoot: project.root, version: this.options.version }),
      });
    } catch (err) {
      throw new TerminalError(`could not start ${shell.shell}: ${err instanceof Error ? err.message : String(err)}`, 500);
    }
    const id = `t_${randomBytes(6).toString("hex")}`;
    const title = request.title?.trim() || (cwd === allowedRoots(project)[0] ? path.basename(shell.shell) : path.basename(cwd));
    const session: Session = {
      info: {
        id,
        projectId: project.id,
        title,
        cwd,
        shell: shell.shell,
        pid: pty.pid,
        cols: request.cols,
        rows: request.rows,
        createdAt: new Date(this.now()).toISOString(),
        status: "running",
        exitCode: null,
        signal: null,
      },
      pty,
      history: new ScrollbackBuffer(this.options.scrollbackBytes ?? DEFAULT_SCROLLBACK_BYTES),
      sinks: new Map(),
      paused: false,
      altScreen: false,
      bracketedPaste: false,
      unsubscribe: [],
    };
    this.sessions.set(id, session);
    this.lastOpen.set(project.id, this.now());
    session.unsubscribe.push(
      pty.onData((data) => this.onData(session, data)),
      pty.onExit((event) => this.onExit(session, event.exitCode, event.signal)),
    );
    const input = request.input?.replace(/[\r\n]+$/, "");
    if (input !== undefined && input.length > 0) {
      session.pendingInput = {
        text: input,
        timer: undefined,
        deadline: setTimeout(() => this.flushInitialInput(session), INITIAL_INPUT_MAX_MS),
      };
    }
    this.changed(project.id);
    return { ...session.info };
  }

  /** Subscribes `sink` to a terminal's output and exit; returns the replay (scrollback) to paint first. */
  attach(id: string, sink: TerminalSink): { terminal: TerminalInfo; replay: string } {
    const session = this.get(id);
    session.sinks.set(sink, { unacked: 0 });
    // A full-screen app (vim, top, less) only redraws on SIGWINCH: nudge the size.
    if (session.altScreen && session.pty !== null) {
      const { cols, rows } = session.info;
      const pty = session.pty;
      try {
        pty.resize(cols, Math.max(2, rows - 1));
        setTimeout(() => {
          if (session.pty === pty) this.safeResize(session, session.info.cols, session.info.rows);
        }, 40).unref();
      } catch {
        /* exited meanwhile */
      }
    }
    return { terminal: { ...session.info }, replay: session.history.value() };
  }

  detach(id: string, sink: TerminalSink): void {
    const session = this.sessions.get(id);
    if (session === undefined) return;
    session.sinks.delete(sink);
    this.updateFlow(session);
  }

  /** Removes a closed viewer connection from every terminal. */
  detachAll(sink: TerminalSink): void {
    for (const session of this.sessions.values()) {
      if (session.sinks.delete(sink)) this.updateFlow(session);
    }
  }

  input(id: string, data: string): void {
    const session = this.get(id);
    if (session.pty === null) return;
    session.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.get(id);
    session.info.cols = cols;
    session.info.rows = rows;
    this.safeResize(session, cols, rows);
  }

  rename(id: string, title: string): void {
    const session = this.get(id);
    const next = title.trim();
    if (next.length === 0 || next === session.info.title) return;
    session.info.title = next;
    this.changed(session.info.projectId);
  }

  clear(id: string): void {
    this.get(id).history.clear();
  }

  ack(id: string, sink: TerminalSink, chars: number): void {
    const session = this.sessions.get(id);
    const state = session?.sinks.get(sink);
    if (session === undefined || state === undefined) return;
    state.unacked = Math.max(0, state.unacked - chars);
    this.updateFlow(session);
  }

  /** Closes a terminal: the shell gets SIGHUP (SIGKILL after 2 s) and the tab disappears. */
  kill(id: string): void {
    const session = this.get(id);
    this.dispose(session);
    this.changed(session.info.projectId);
  }

  /** Kills the terminals of projects that have not been open for idleMs. */
  sweep(now = this.now()): void {
    const current = this.currentProjectId();
    const idleMs = this.options.idleMs ?? DEFAULT_IDLE_MS;
    const stale = new Set<string>();
    for (const session of this.sessions.values()) {
      const projectId = session.info.projectId;
      if (projectId === current) {
        this.lastOpen.set(projectId, now);
        continue;
      }
      const since = this.lastOpen.get(projectId);
      if (since === undefined) this.lastOpen.set(projectId, now);
      else if (now - since > idleMs) stale.add(projectId);
    }
    for (const projectId of stale) {
      for (const session of [...this.sessions.values()]) if (session.info.projectId === projectId) this.dispose(session);
      this.lastOpen.delete(projectId);
      this.changed(projectId);
    }
  }

  /**
   * Daemon exit: SIGHUP every shell (it hangs up its jobs, like closing a
   * terminal window), wait up to `graceMs` for them to exit, SIGKILL the rest.
   */
  async shutdown(graceMs = 500): Promise<void> {
    this.closed = true;
    if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer);
    const live = [...this.sessions.values()].filter((s) => s.pty !== null);
    const exited = live.map(
      (s) =>
        new Promise<void>((resolve) => {
          const off = s.pty?.onExit(() => resolve());
          if (off === undefined) resolve();
        }),
    );
    const ptys = live.map((s) => s.pty).filter((p): p is PtyProcess => p !== null);
    for (const session of [...this.sessions.values()]) this.dispose(session, { immediate: true });
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all(exited), new Promise<void>((resolve) => (timer = setTimeout(resolve, graceMs)))]);
    if (timer !== undefined) clearTimeout(timer);
    for (const pty of ptys) {
      try {
        pty.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }

  /** Synchronous last resort (process "exit"): hang up whatever is still running. */
  hangUpAll(): void {
    for (const session of this.sessions.values()) {
      try {
        session.pty?.kill("SIGHUP");
      } catch {
        /* gone */
      }
    }
  }

  private shell(): ShellCommand {
    return this.options.shell ?? resolveShell(this.options.env ?? process.env);
  }

  private get(id: string): Session {
    const session = this.sessions.get(id);
    if (session === undefined) throw new TerminalError(`unknown terminal "${id}"`, 404);
    return session;
  }

  private changed(projectId: string): void {
    for (const listener of this.listeners) listener(projectId);
  }

  private safeResize(session: Session, cols: number, rows: number): void {
    try {
      session.pty?.resize(cols, rows);
    } catch {
      /* the process exited between the check and the call */
    }
  }

  private onData(session: Session, data: string): void {
    session.history.append(data);
    session.altScreen = altScreenAfter(session.altScreen, data);
    session.bracketedPaste = modeAfter(session.bracketedPaste, data, "2004");
    const pending = session.pendingInput;
    if (pending !== undefined) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.timer = setTimeout(() => this.flushInitialInput(session), INITIAL_INPUT_QUIET_MS);
    }
    let behind = false;
    for (const [sink, state] of session.sinks) {
      state.unacked += data.length;
      if (state.unacked > FLOW_HIGH_WATERMARK) behind = true;
      sink({ type: "output", id: session.info.id, data });
    }
    if (behind && !session.paused && session.pty !== null) {
      session.paused = true;
      session.pty.pause();
    }
  }

  private updateFlow(session: Session): void {
    if (!session.paused || session.pty === null) return;
    for (const state of session.sinks.values()) if (state.unacked > FLOW_LOW_WATERMARK) return;
    session.paused = false;
    session.pty.resume();
  }

  private flushInitialInput(session: Session): void {
    const pending = session.pendingInput;
    if (pending === undefined) return;
    session.pendingInput = undefined;
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    clearTimeout(pending.deadline);
    if (session.pty === null) return;
    session.pty.write(pastedCommand(pending.text, session.bracketedPaste));
  }

  private onExit(session: Session, exitCode: number, signal: number | null): void {
    if (session.killTimer !== undefined) clearTimeout(session.killTimer);
    for (const off of session.unsubscribe.splice(0)) off();
    session.pty = null;
    if (session.pendingInput !== undefined) {
      if (session.pendingInput.timer !== undefined) clearTimeout(session.pendingInput.timer);
      clearTimeout(session.pendingInput.deadline);
      session.pendingInput = undefined;
    }
    if (!this.sessions.has(session.info.id)) return; // killed by the user: already gone
    session.info.status = "exited";
    session.info.exitCode = exitCode;
    session.info.signal = signal !== null && signal !== 0 ? signal : null;
    for (const sink of session.sinks.keys()) sink({ type: "exit", id: session.info.id, exitCode, signal: session.info.signal });
    this.changed(session.info.projectId);
  }

  private dispose(session: Session, options: { immediate?: boolean } = {}): void {
    this.sessions.delete(session.info.id);
    const pending = session.pendingInput;
    if (pending !== undefined) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      clearTimeout(pending.deadline);
      session.pendingInput = undefined;
    }
    const pty = session.pty;
    if (pty === null) return;
    if (session.paused) pty.resume();
    try {
      pty.kill("SIGHUP");
    } catch {
      /* already gone */
    }
    if (options.immediate === true) return;
    session.killTimer = setTimeout(() => {
      if (session.pty === pty) {
        try {
          pty.kill("SIGKILL");
        } catch {
          /* gone */
        }
      }
    }, KILL_GRACE_MS);
    session.killTimer.unref();
  }
}
