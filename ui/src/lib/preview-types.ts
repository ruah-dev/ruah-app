// CONTRACTS.md §15 — the live preview's types, field for field with src/contracts/preview.ts.

export type PreviewState = "stopped" | "starting" | "running" | "crashed";
export type PreviewKind = "script" | "python" | "ruby" | "go" | "compose" | "deno" | "static" | "custom";

export interface PreviewCandidate {
  /** "<dir>#<name>": ".#dev", "apps/web#dev", "api#django", ".#static"; "custom" = your command. */
  id: string;
  title: string;
  command: string;
  dir: string;
  framework: string;
  kind: PreviewKind;
  port?: number;
  hmr: boolean;
  reason: string;
  score: number;
  workspace?: string;
  env?: Record<string, string>;
  needs?: string;
  available?: boolean;
  install?: string;
  setup?: string;
}

export interface PreviewFile {
  version: 1;
  candidate?: string;
  command?: string;
  dir?: string;
  url?: string;
}

export interface PreviewDetection {
  root: string;
  candidates: PreviewCandidate[];
  monorepo: boolean;
  packageManager?: "pnpm" | "yarn" | "npm" | "bun";
  selected: string | null;
  choice: PreviewFile | null;
  configError?: string;
  truncated: boolean;
}

export interface PreviewStatus {
  projectId: string;
  root: string;
  /** Grows with every pushed change; keep the highest (an HTTP answer may race a newer push). */
  rev: number;
  state: PreviewState;
  candidate: PreviewCandidate | null;
  command: string | null;
  cwd: string | null;
  url: string | null;
  port: number | null;
  healthy: boolean;
  framing: "ok" | "blocked" | "unknown";
  hmr: boolean;
  runner: "pty" | "process" | "static" | null;
  terminalId: string | null;
  pid: number | null;
  startedAt: string | null;
  exitCode: number | null;
  signal: number | null;
  error?: string;
  logs: string[];
}
