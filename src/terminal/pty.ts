// Adapted from t3code apps/server/src/terminal/NodePtyAdapter.ts and PtyAdapter.ts (MIT, eff44be43) — see THIRD_PARTY_NOTICES.md
//
// The PTY layer: a small process interface the terminal manager drives, and
// the lazy node-pty loader behind it. node-pty is a native addon, so it is
// never imported at module load: a daemon whose node-pty cannot load (wrong
// platform, missing prebuild, broken install) keeps running with the terminal
// disabled and a message saying how to fix it. node-pty 1.1.0 ships N-API
// prebuilds for macOS and Windows, which load under both the system Node and
// Electron's Node (ELECTRON_RUN_AS_NODE) without a rebuild.
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

export interface PtyExitEvent {
  exitCode: number;
  signal: number | null;
}

export interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
  onData(callback: (data: string) => void): () => void;
  onExit(callback: (event: PtyExitEvent) => void): () => void;
}

export interface PtySpawnInput {
  shell: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
}

export interface PtyBackend {
  spawn(input: PtySpawnInput): PtyProcess;
}

export type PtyLoadResult = { ok: true; backend: PtyBackend } | { ok: false; reason: string };

/** What the viewer shows when node-pty cannot load. */
export function unavailableMessage(detail: string): string {
  return `Terminal unavailable: node-pty could not be loaded (${detail}). Run \`pnpm rebuild node-pty\` in the ruah-app folder and restart Ruah.`;
}

type NodePtyModule = typeof import("node-pty");

const requireForNodePty = createRequire(import.meta.url);

// pnpm (≥ 10) skips install scripts unless allowed, and the 1.1.0 tarball ships
// prebuilds/<platform>/spawn-helper without the execute bit: posix_spawnp then
// fails on every spawn. Make it executable once (best effort).
function ensureSpawnHelperExecutable(): void {
  if (process.platform === "win32") return;
  let packageDir: string;
  try {
    packageDir = path.dirname(requireForNodePty.resolve("node-pty/package.json"));
  } catch {
    return;
  }
  const candidates = [
    path.join(packageDir, "build", "Release", "spawn-helper"),
    path.join(packageDir, "build", "Debug", "spawn-helper"),
    path.join(packageDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
  ];
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if ((stat.mode & 0o111) !== 0o111) fs.chmodSync(candidate, 0o755);
    } catch {
      /* missing or read-only install: spawn reports the real error */
    }
  }
}

class NodePtyProcess implements PtyProcess {
  constructor(private readonly process: import("node-pty").IPty) {}

  get pid(): number {
    return this.process.pid;
  }

  write(data: string): void {
    this.process.write(data);
  }

  resize(cols: number, rows: number): void {
    this.process.resize(cols, rows);
  }

  kill(signal?: string): void {
    // node-pty terminates the Windows process tree without a POSIX signal.
    this.process.kill(process.platform === "win32" ? undefined : signal);
  }

  pause(): void {
    this.process.pause();
  }

  resume(): void {
    this.process.resume();
  }

  onData(callback: (data: string) => void): () => void {
    const disposable = this.process.onData(callback);
    return () => disposable.dispose();
  }

  onExit(callback: (event: PtyExitEvent) => void): () => void {
    const disposable = this.process.onExit((event) => callback({ exitCode: event.exitCode, signal: event.signal ?? null }));
    return () => disposable.dispose();
  }
}

function backendFor(nodePty: NodePtyModule): PtyBackend {
  return {
    spawn(input) {
      return new NodePtyProcess(
        nodePty.spawn(input.shell, input.args, {
          name: "xterm-256color",
          cwd: input.cwd,
          cols: input.cols,
          rows: input.rows,
          env: input.env,
          encoding: "utf8",
        }),
      );
    },
  };
}

let cached: Promise<PtyLoadResult> | undefined;

/**
 * Loads node-pty once (lazily, on the first terminal request). Never throws:
 * a failure is reported as `{ ok: false, reason }` with the fix in the text.
 * `RUAH_TERMINAL_DISABLE_PTY=1` simulates a missing module (tests, support).
 */
export function loadPty(): Promise<PtyLoadResult> {
  cached ??= Promise.resolve().then((): PtyLoadResult => {
    if (process.env.RUAH_TERMINAL_DISABLE_PTY === "1") return { ok: false, reason: unavailableMessage("disabled by RUAH_TERMINAL_DISABLE_PTY") };
    try {
      // `require`, not `import()`: the addon and its spawn-helper resolve from the real filesystem.
      const nodePty = requireForNodePty("node-pty") as NodePtyModule;
      ensureSpawnHelperExecutable();
      return { ok: true, backend: backendFor(nodePty) };
    } catch (err) {
      const detail = err instanceof Error ? err.message.split("\n")[0] ?? err.message : String(err);
      return { ok: false, reason: unavailableMessage(`${process.platform}-${process.arch}, Node ${process.versions.node}: ${detail}`) };
    }
  });
  return cached;
}
