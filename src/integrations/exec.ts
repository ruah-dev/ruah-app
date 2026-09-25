// src/integrations/exec.ts — the one way integrations run provider CLIs:
// execFile with an args array (never a shell string), a 20 s timeout, bounded
// output, a PATH that also covers Homebrew (GUI launches start with a bare
// PATH), and error messages that never contain the arguments and are
// scrubbed of secrets.
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import * as path from "node:path";

export const CLI_TIMEOUT_MS = 20_000;
const MAX_BUFFER = 32 * 1024 * 1024;
const EXTRA_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  /** Written to the child's stdin, then closed (secrets go here, never in args). */
  input?: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs `file` with `args`. Resolves with the exit code for a normal exit
 * (including non-zero) and rejects with CliError when the process could not
 * be started or timed out. Tests pass fakes.
 */
export type Runner = (file: string, args: readonly string[], options?: RunOptions) => Promise<RunResult>;

/** An HTTP-mappable error whose message is safe to show to the viewer. */
export class IntegrationError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "IntegrationError";
  }
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly kind: "missing" | "timeout" | "failed",
  ) {
    super(message);
    this.name = "CliError";
  }
}

export function searchPath(env: NodeJS.ProcessEnv = process.env): string {
  const dirs = (env.PATH ?? "").split(path.delimiter).filter((d) => d.length > 0);
  for (const extra of EXTRA_BIN_DIRS) if (!dirs.includes(extra)) dirs.push(extra);
  return dirs.join(path.delimiter);
}

/** Absolute path of an executable on PATH (+ Homebrew dirs), or undefined. */
export function resolveBin(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (name.includes("/")) return name;
  for (const dir of searchPath(env).split(path.delimiter)) {
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

export const defaultRunner: Runner = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    const label = path.basename(file);
    const child = execFile(
      file,
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? CLI_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, PATH: searchPath(), NO_COLOR: "1", AWS_PAGER: "", GH_PROMPT_DISABLED: "1", ...options.env },
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: unknown };
        if (err.code === "ENOENT") {
          reject(new CliError(`${label} is not installed`, "missing"));
          return;
        }
        // Output over maxBuffer also kills the child (killed = true): not a timeout.
        if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          reject(new CliError(`${label} printed more than ${Math.round(MAX_BUFFER / 1_048_576)} MiB`, "failed"));
          return;
        }
        if (err.killed === true || err.signal === "SIGTERM") {
          reject(new CliError(`${label} timed out after ${Math.round((options.timeoutMs ?? CLI_TIMEOUT_MS) / 1000)} s`, "timeout"));
          return;
        }
        if (typeof err.code === "number") {
          resolve({ code: err.code, stdout, stderr });
          return;
        }
        // Never include error.message: Node puts the full command line (args) in it.
        reject(new CliError(`${label} failed to run`, "failed"));
      },
    );
    if (options.input !== undefined) {
      child.stdin?.on("error", () => {}); // the exit callback reports failures
      child.stdin?.end(options.input);
    }
  });

// ---- redaction ---------------------------------------------------------------

const R = "[redacted]";
const SECRET_PATTERNS: [RegExp, string][] = [
  [/\b(Basic|Bearer)\s+[A-Za-z0-9+/=._~-]{8,}/gi, `$1 ${R}`], // auth headers
  [/\b(token)(\s*[=:]?\s*)(?=[A-Za-z0-9+/=._~-]*\d)[A-Za-z0-9+/=._~-]{16,}/gi, `$1$2${R}`], // "token abc123…" (needs a digit, >= 16 chars)
  [/\b(aws_secret_access_key|aws_session_token|password|secret)(\s*[=:]\s*)\S+/gi, `$1$2${R}`],
  [/\bA[KS]IA[0-9A-Z]{16}\b/g, R], // AWS access key ids
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, R], // GitHub tokens
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, R],
  [/\bdo[por]_v1_[a-f0-9]{32,}\b/g, R], // DigitalOcean tokens
  [/\bATATT[A-Za-z0-9_=-]{20,}/g, R], // Atlassian API tokens
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, R],
  [/(\s-w\s+)\S+/g, `$1${R}`], // a `security … -w <secret>` echoed back
];

/** Replaces known secrets and secret-shaped strings with "[redacted]". */
export function redact(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret === undefined || secret.length < 4) continue;
    out = out.split(secret).join(R);
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** First meaningful line(s) of CLI stderr/stdout for an error message. */
export function cliMessage(result: RunResult, secrets: readonly (string | undefined)[] = []): string {
  const raw = (result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`)
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, "");
  // doctl prints {"errors":[{"detail":"…"}]} on stdout/stderr.
  let text = raw;
  try {
    const parsed = JSON.parse(raw) as { errors?: { detail?: unknown }[] };
    const detail = parsed.errors?.map((e) => (typeof e.detail === "string" ? e.detail : "")).filter(Boolean).join("; ");
    if (detail !== undefined && detail.length > 0) text = detail;
  } catch {
    // not JSON
  }
  const trimmed = text.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3).join(" ");
  return redact(trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed, secrets);
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

/** Runs async jobs with bounded concurrency, preserving order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---- defensive readers for untyped CLI JSON ---------------------------------

export type Json = Record<string, unknown>;

export function obj(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}
export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
export function str(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}
