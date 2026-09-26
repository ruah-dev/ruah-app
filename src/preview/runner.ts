// How a dev server process runs. Three runners behind one interface:
//   - PtyRunner: a PTY from the daemon's terminal manager (§7), so the output
//     is a "preview" tab in the terminal panel and the server sees a real TTY
//     (colours, Vite's key shortcuts); stop = Ctrl+C, then hang up. After a
//     stop the tab is closed (`close`); a crashed server's tab stays (its
//     output) until the next start or stop. The user closing the tab reports
//     the exit as `closed` (a stop, not a crash).
//   - ProcessRunner: a plain child process in its own process group (node-pty
//     missing, or the CLI); stop = SIGINT to the group, then SIGTERM / SIGKILL.
//   - the static server (static-server.ts) runs in-process; the manager
//     handles it directly.
// Commands run with `/bin/sh -c` in the resolved shell environment.
import { spawn, type ChildProcess } from "node:child_process";
import type { TerminalManager, TerminalSink } from "../terminal/manager.js";

export interface RunSpec {
  command: string;
  /** Absolute folder. */
  cwd: string;
  env: Record<string, string>;
  title: string;
}

export interface RunnerEvents {
  onData(text: string): void;
  /** `closed`: the user closed its terminal tab (the process was hung up) — a stop, not a crash. */
  onExit(exitCode: number | null, signal: number | null, closed?: boolean): void;
}

export interface RunningProcess {
  readonly kind: "pty" | "process";
  readonly pid: number | null;
  readonly terminalId: string | null;
  /** Ctrl+C / SIGINT: dev servers shut down cleanly on it. */
  interrupt(): void;
  /** Hang up / terminate, then kill after a grace period. */
  kill(): void;
  /** The runner's resources (listeners) — after the exit. */
  dispose(): void;
  /** Removes what is left after the exit: the PTY's (exited) terminal tab. No-op for a plain process. */
  close(): void;
}

export interface Runner {
  readonly kind: "pty" | "process";
  start(spec: RunSpec, events: RunnerEvents): Promise<RunningProcess>;
}

export function shellCommand(command: string, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  if (platform === "win32") return { file: process.env.COMSPEC ?? "cmd.exe", args: ["/d", "/s", "/c", command] };
  return { file: "/bin/sh", args: ["-c", command] };
}

export class PtyRunner implements Runner {
  readonly kind = "pty" as const;

  constructor(private readonly terminals: TerminalManager) {}

  async start(spec: RunSpec, events: RunnerEvents): Promise<RunningProcess> {
    const program = shellCommand(spec.command);
    const info = await this.terminals.create({
      cwd: spec.cwd,
      cols: 120,
      rows: 32,
      title: spec.title,
      exec: { file: program.file, args: program.args, env: spec.env },
      kind: "preview",
    });
    const id = info.id;
    const terminals = this.terminals;
    let exited = false;
    const exit = (code: number | null, signal: number | null, closed = false): void => {
      if (exited) return;
      exited = true;
      offChange();
      events.onExit(code, signal, closed);
    };
    const sink: TerminalSink = (message) => {
      if (message.type === "output" && message.id === id) {
        events.onData(message.data);
        // This sink renders nothing: acknowledge at once so flow control never pauses the server.
        terminals.ack(id, sink, message.data.length);
      } else if (message.type === "exit" && message.id === id) exit(message.exitCode, message.signal);
    };
    const { replay } = terminals.attach(id, sink);
    if (replay.length > 0) events.onData(replay);
    // Closing the tab in the terminal panel hangs the process up without an exit event to this sink.
    const offChange = terminals.onChange((projectId) => {
      if (projectId !== info.projectId || exited) return;
      if (!terminals.list(projectId).some((t) => t.id === id)) exit(null, 1, true);
    });
    return {
      kind: "pty",
      pid: info.pid,
      terminalId: id,
      interrupt: () => {
        try {
          terminals.input(id, "\u0003");
        } catch {
          /* already gone */
        }
      },
      kill: () => {
        try {
          terminals.kill(id);
        } catch {
          /* already gone */
        }
      },
      dispose: () => {
        offChange();
        terminals.detach(id, sink);
      },
      close: () => {
        offChange();
        terminals.detach(id, sink);
        try {
          terminals.kill(id);
        } catch {
          /* the user closed it already */
        }
      },
    };
  }
}

export interface ProcessRunnerOptions {
  /** Own process group (daemon: kill the whole tree); false = share the CLI's so Ctrl+C reaches it. */
  detached?: boolean;
  /** Also write the output here (the CLI's foreground mode). */
  tee?: (text: string, stream: "stdout" | "stderr") => void;
}

export class ProcessRunner implements Runner {
  readonly kind = "process" as const;
  private readonly children = new Set<ChildProcess>();

  constructor(private readonly options: ProcessRunnerOptions = {}) {}

  start(spec: RunSpec, events: RunnerEvents): Promise<RunningProcess> {
    const program = shellCommand(spec.command);
    const detached = this.options.detached ?? true;
    const child = spawn(program.file, program.args, {
      cwd: spec.cwd,
      env: { ...spec.env, FORCE_COLOR: spec.env.FORCE_COLOR ?? "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached,
    });
    this.children.add(child);
    const signalNumber = (name: NodeJS.Signals | null): number | null => {
      if (name === null) return null;
      const table: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
      return table[name] ?? 1;
    };
    return new Promise((resolve, reject) => {
      let started = false;
      child.once("error", (err) => {
        this.children.delete(child);
        if (!started) reject(err);
        else events.onExit(127, null);
      });
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (d: string) => {
        this.options.tee?.(d, "stdout");
        events.onData(d);
      });
      child.stderr?.on("data", (d: string) => {
        this.options.tee?.(d, "stderr");
        events.onData(d);
      });
      child.once("exit", (code, signal) => {
        this.children.delete(child);
        events.onExit(code, signalNumber(signal));
      });
      const send = (sig: NodeJS.Signals): void => {
        if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
        try {
          if (detached && process.platform !== "win32") process.kill(-child.pid, sig);
          else child.kill(sig);
        } catch {
          /* gone */
        }
      };
      child.once("spawn", () => {
        started = true;
        resolve({
          kind: "process",
          pid: child.pid ?? null,
          terminalId: null,
          interrupt: () => send("SIGINT"),
          kill: () => {
            send("SIGTERM");
            setTimeout(() => send("SIGKILL"), 2000).unref();
          },
          dispose: () => {},
          close: () => {},
        });
      });
    });
  }

  /** Synchronous last resort (process exit): terminate every child's group. */
  killAll(): void {
    for (const child of this.children) {
      if (child.pid === undefined) continue;
      try {
        if ((this.options.detached ?? true) && process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        /* gone */
      }
    }
  }
}
