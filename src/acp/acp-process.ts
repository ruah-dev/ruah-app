// Adapted from t3code apps/server/src/provider/acp/AcpSessionRuntime.ts (spawn,
// bounded stderr, retireRuntime kill with forceKillAfter) (MIT, eff44be43) —
// see THIRD_PARTY_NOTICES.md
//
// src/acp/acp-process.ts — one ACP agent child process: spawn from an
// AcpPreset with cwd = repo root, ndJsonStream over stdin/stdout, a 64 KiB
// stderr ring for error messages, and exactly one `exited` settlement.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ndJsonStream, type Stream } from "@agentclientprotocol/sdk";
import type { AcpPreset } from "./bridge.js";

const STDERR_RING_BYTES = 64 * 1024;
// t3code maxStderrChunkLength: bound what a single chunk hands to the listener.
const MAX_STDERR_CHUNK = 32 * 1024;
const DEFAULT_KILL_GRACE_MS = 1_000;

export interface AgentExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Spawn failure (e.g. ENOENT) when the process never started. */
  error?: Error;
}

export class AgentProcess {
  readonly stream: Stream;
  /** Settles once, when the process has exited or failed to spawn. */
  readonly exited: Promise<AgentExit>;
  private readonly child: ChildProcessWithoutNullStreams;
  private stderrRing = "";
  private exitInfo: AgentExit | undefined;

  constructor(preset: AcpPreset, cwd: string, onStderr?: (chunk: string) => void) {
    this.child = spawn(preset.command, preset.args, {
      cwd,
      env: { ...process.env, ...preset.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settle: (exit: AgentExit) => void = () => {};
    this.exited = new Promise<AgentExit>((resolve) => {
      settle = resolve;
    });
    const finish = (exit: AgentExit): void => {
      if (this.exitInfo !== undefined) return;
      this.exitInfo = exit;
      settle(exit);
    };
    this.child.once("error", (error) => finish({ code: null, signal: null, error }));
    this.child.once("exit", (code, signal) => finish({ code, signal }));
    // Writes to a dead child's stdin surface as EPIPE on the stream; the exit
    // path reports the real cause, so swallow them here.
    this.child.stdin.on("error", () => {});
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrRing = (this.stderrRing + chunk).slice(-STDERR_RING_BYTES);
      onStderr?.(chunk.slice(-MAX_STDERR_CHUNK));
    });
    this.stream = ndJsonStream(
      Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>,
    );
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get hasExited(): boolean {
    return this.exitInfo !== undefined;
  }

  /** Last `maxChars` of stderr, trimmed. */
  stderrTail(maxChars = 2_000): string {
    return this.stderrRing.slice(-maxChars).trim();
  }

  /** SIGTERM, then SIGKILL after `graceMs` (t3code `child.kill({ forceKillAfter: "1 second" })`). */
  async kill(graceMs = DEFAULT_KILL_GRACE_MS): Promise<AgentExit> {
    if (this.exitInfo !== undefined) return this.exitInfo;
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (this.exitInfo === undefined) this.child.kill("SIGKILL");
    }, graceMs);
    try {
      return await this.exited;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function describeExit(exit: AgentExit, stderrTail: string): string {
  const head = exit.error !== undefined
    ? `agent failed to start: ${exit.error.message}`
    : `agent exited (code ${exit.code ?? "null"}, signal ${exit.signal ?? "null"})`;
  return stderrTail ? `${head}\n${stderrTail}` : head;
}
