// src/usage/limits/stdio-rpc.ts — the smallest JSON-RPC 2.0 client over a
// child's stdio (newline-delimited, as ACP agents speak it): enough to run an
// agent's own read-only command (Kiro's /usage) and close it. Requests from
// the agent are refused (permission requests are cancelled), notifications
// are ignored; nothing is logged.
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export interface RpcChild {
  stdin: Writable | null;
  stdout: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null) => void): unknown;
  once(event: "error", listener: (err: Error) => void): unknown;
}

export type Spawner = (command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => RpcChild;

export const defaultSpawner: Spawner = (command, args, options) =>
  spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class StdioRpc {
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, Pending>();
  private closed = false;

  constructor(private readonly child: RpcChild) {
    child.stdin?.on("error", () => {}); // EPIPE after exit: the exit handler reports it
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    child.once("exit", () => this.fail(new RpcError("the agent exited", undefined)));
    child.once("error", () => this.fail(new RpcError("the agent could not be started", undefined)));
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new RpcError("the agent exited", undefined));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(`${method} timed out after ${Math.round(timeoutMs / 1000)} s`, undefined));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  close(): void {
    this.fail(new RpcError("closed", undefined));
    try {
      this.child.stdin?.end();
    } catch {
      // already gone
    }
    this.child.kill("SIGTERM");
  }

  private write(message: unknown): void {
    try {
      this.child.stdin?.write(`${JSON.stringify(message)}\n`);
    } catch {
      // the exit handler rejects what is pending
    }
  }

  private fail(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) this.onMessage(line);
    }
  }

  private onMessage(line: string): void {
    let msg: { id?: unknown; method?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return; // not a protocol line
    }
    if (typeof msg.method === "string") {
      if (msg.id === undefined || msg.id === null) return; // notification
      // A request from the agent: cancel permission prompts, refuse the rest.
      if (msg.method === "session/request_permission") {
        this.write({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } });
      } else {
        this.write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not supported by this client" } });
      }
      return;
    }
    if (typeof msg.id !== "number") return;
    const p = this.pending.get(msg.id);
    if (p === undefined) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error !== undefined && msg.error !== null) {
      const message = typeof msg.error.message === "string" ? msg.error.message : "request failed";
      p.reject(new RpcError(message, typeof msg.error.code === "number" ? msg.error.code : undefined));
    } else {
      p.resolve(msg.result);
    }
  }
}
