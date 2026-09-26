// src/extensions/model.ts — shared helpers of the extensions library
// (CONTRACTS §15): ids, agent names, URL checks, Keychain account names,
// placeholder expansion and the fingerprint that ties an approval to exactly
// what an extension runs.
import { createHash } from "node:crypto";
import * as path from "node:path";
import {
  EXTENSION_AGENTS,
  type Extension,
  type ExtensionAgent,
  type ExtensionScope,
  type McpRuns,
  type WhatItRuns,
} from "../contracts/extensions.js";

export class ExtensionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ExtensionError";
  }
}

export const AGENT_NAMES: Record<ExtensionAgent, string> = {
  claude: "Claude Code",
  cursor: "Cursor Agent",
  grok: "Grok Build",
  kiro: "Kiro CLI",
  opencode: "OpenCode",
};

export function isExtensionAgent(value: string): value is ExtensionAgent {
  return (EXTENSION_AGENTS as readonly string[]).includes(value);
}

/**
 * The extension agent whose enablement applies to a bridge agent id.
 * claude-acp (CLI-only Claude over ACP) shares Claude's switches.
 */
export function extensionAgentFor(agentId: string): ExtensionAgent | undefined {
  if (agentId === "claude-acp") return "claude";
  return isExtensionAgent(agentId) ? agentId : undefined;
}

/** A slug for ids derived from names / folders / URLs. */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/\.git$/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 63)
    .replace(/[-._]+$/g, "");
  return slug.length === 0 || slug === "ruah" ? `ext-${slug || "x"}` : slug;
}

/** Keychain account of one secret (service "ruah", src/integrations/keychain.ts). */
export function secretAccount(scopeKey: string, id: string, name: string): string {
  return `ext:${scopeKey}:${id}:${name}`;
}

/** "global" or the project id (CONTRACTS §5.1). */
export function scopeKeyOf(scope: ExtensionScope, projectId: string | undefined): string {
  if (scope === "global") return "global";
  if (projectId === undefined) throw new ExtensionError(409, "no project is open");
  return projectId;
}

/** `${project}` and `${home}` in stdio args; nothing else is expanded. */
export function expandPlaceholders(value: string, vars: { project: string; home: string }): string {
  return value.replace(/\$\{(project|home)\}/g, (_, key: "project" | "home") => vars[key]);
}

// ---- URL checks ------------------------------------------------------------------

/** Remote MCP endpoints: https anywhere, http only on loopback (Figma desktop, local dev servers). */
export function validateMcpUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ExtensionError(400, `not a URL: ${raw}`);
  }
  if (url.username !== "" || url.password !== "") throw new ExtensionError(400, "credentials in the URL are not allowed; store them as a header secret");
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol === "https:") return url.toString();
  if (url.protocol === "http:" && loopback) return url.toString();
  throw new ExtensionError(400, "MCP URLs must be https:// (http:// only for localhost)");
}

/**
 * Git sources: https://, ssh:// and scp-like git@host:path. No ext::, file://
 * (except when allowed for tests), no option-looking values.
 */
export function validateGitUrl(raw: string, options: { allowFile?: boolean } = {}): string {
  const value = raw.trim();
  if (value.startsWith("-")) throw new ExtensionError(400, "invalid git URL");
  if (/[\s\0]/.test(value)) throw new ExtensionError(400, "invalid git URL");
  if (/^[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+:[A-Za-z0-9_./~-]+$/.test(value)) return value; // git@github.com:owner/repo.git
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ExtensionError(400, `not a git URL: ${value}`);
  }
  if (url.protocol === "https:" || url.protocol === "ssh:") {
    // https://<token>@host/… carries a credential in the user name: it would be written into the
    // (committable) extensions file and could show in clone errors. ssh:// keeps its login name.
    if (url.password !== "" || (url.protocol === "https:" && url.username !== "")) {
      throw new ExtensionError(400, "credentials in the URL are not allowed; let git's credential helper supply them");
    }
    return url.toString();
  }
  if (url.protocol === "file:" && options.allowFile === true) return url.toString();
  throw new ExtensionError(400, "git URLs must be https://, ssh:// or git@host:path");
}

/** A relative sub-path that stays inside its base (no absolute paths, no `..` escapes). */
export function safeSubpath(base: string, sub: string): string {
  if (sub.length === 0) return base;
  if (path.isAbsolute(sub) || sub.includes("\0")) throw new ExtensionError(400, "subdir must be a relative path");
  const resolved = path.resolve(base, sub);
  const rel = path.relative(base, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new ExtensionError(400, "subdir escapes the source folder");
  return resolved;
}

export function validateRuns(runs: McpRuns): McpRuns {
  if (runs.type === "stdio") {
    if (runs.command.includes("\0") || runs.args.some((a) => a.includes("\0"))) throw new ExtensionError(400, "invalid command");
    // A command, never a shell line: "npx -y foo" in the command field is almost always a mistake.
    if (/\s/.test(runs.command) && !path.isAbsolute(runs.command)) {
      throw new ExtensionError(400, "command must be a single executable; put its arguments in args");
    }
    return runs;
  }
  return { ...runs, url: validateMcpUrl(runs.url) };
}

// ---- fingerprint ------------------------------------------------------------------

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** JSON with object keys sorted at every level (hashes that do not depend on key order). */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v === undefined ? null : v)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The part of a server the fingerprint covers beyond "what it runs": literal env / header values (hashed, never shown). */
export interface FingerprintServer {
  name: string;
  envValues: Record<string, string>;
  headerValues: Record<string, string>;
}

/**
 * Hash of everything an extension would run: its kind, source, server
 * definitions (including bundled ones read from disk, with their literal env
 * and header values: NODE_OPTIONS changes what a server runs), the commands a
 * plugin runs (hooks, LSP servers, monitors) and `digest`, the hash of the
 * runnable config files and of the script files those commands point to
 * inside the extension folder (src/extensions/inspect.ts). Approving
 * (enabling) records it; a change needs a new approval.
 */
export function fingerprint(
  ext: Pick<Extension, "kind" | "source" | "runs" | "env">,
  what: WhatItRuns,
  extra: { servers?: readonly FingerprintServer[]; digest?: string } = {},
): string {
  const payload = stableStringify({
    kind: ext.kind,
    source: ext.source,
    runs: ext.runs ?? null,
    env: [...(ext.env ?? [])].sort(),
    servers: what.servers.map((s) => ({ ...s, env: [...s.env].sort() })),
    values: (extra.servers ?? []).map((s) => ({ name: s.name, env: sha256Hex(stableStringify(s.envValues)), headers: sha256Hex(stableStringify(s.headerValues)) })),
    hooks: what.hooks,
    digest: extra.digest ?? null,
  });
  return sha256Hex(payload).slice(0, 32);
}

// ---- redaction (discovery shows other tools' configs) -------------------------------

const SECRET_FLAG = /(token|key|secret|password|passwd|auth|credential|bearer|cookie|(^|[^a-z])pat\b)/i;
const SECRET_VALUE = /^(sk-|sk_|ghp_|gho_|ghs_|github_pat_|glpat-|xox[abprs]-|AKIA|AIza|ya29\.|eyJ)[A-Za-z0-9._-]{8,}|^[A-Fa-f0-9]{32,}$|^[A-Za-z0-9+/_-]{40,}={0,2}$/;
/** Flags whose next argument is a header ("Name: value") or an env pair ("NAME=value"). */
const HEADER_FLAGS = new Set(["--header", "-H", "--headers"]);
const ENV_FLAGS = new Set(["-e", "--env", "--set-env", "--environment"]);

/** "Authorization: Bearer x" → "Authorization: ••••" when the header looks secret; "Bearer x" anywhere → "Bearer ••••". */
function redactHeader(value: string): string {
  const colon = /^([^:\s]+)\s*:\s*(.*)$/.exec(value);
  if (colon !== null && (SECRET_FLAG.test(colon[1] ?? "") || /^(bearer|basic|token)\s/i.test(colon[2] ?? ""))) return `${colon[1]}: ••••`;
  return redactBearer(value);
}

function redactBearer(value: string): string {
  return value.replace(/\b(Bearer|Basic|Token)\s+[^\s"',]+/gi, "$1 ••••");
}

/** "NAME=value" → "NAME=••••" when NAME looks secret (docker -e, env pairs). */
function redactEnvPair(value: string): string {
  const pair = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(value);
  if (pair !== null && (SECRET_FLAG.test(pair[1] ?? "") || SECRET_VALUE.test(pair[2] ?? ""))) return `${pair[1]}=••••`;
  return value;
}

/**
 * Args with likely secrets masked: values of --token/--api-key-style flags,
 * `--header "Authorization: Bearer …"` (mcp-remote), `-e NAME=value` (docker),
 * NAME=value pairs with a secret-looking NAME, "Bearer …" anywhere and
 * token-looking strings.
 */
export function redactArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const prev = args[i - 1] ?? "";
    if (i > 0 && HEADER_FLAGS.has(prev)) {
      out.push(redactHeader(arg));
      continue;
    }
    if (i > 0 && ENV_FLAGS.has(prev)) {
      out.push(redactEnvPair(arg));
      continue;
    }
    const eq = /^(--?[A-Za-z0-9_-]+)=(.*)$/.exec(arg);
    if (eq !== null && SECRET_FLAG.test(eq[1] ?? "")) {
      out.push(`${eq[1]}=••••`);
      continue;
    }
    if (eq !== null && HEADER_FLAGS.has(eq[1] ?? "")) {
      out.push(`${eq[1]}=${redactHeader(eq[2] ?? "")}`);
      continue;
    }
    if (i > 0 && /^--?[A-Za-z0-9_-]+$/.test(prev) && SECRET_FLAG.test(prev) && !arg.startsWith("-")) {
      out.push("••••");
      continue;
    }
    if (SECRET_VALUE.test(arg) && !arg.includes("/")) {
      out.push("••••");
      continue;
    }
    const pair = redactEnvPair(arg);
    if (pair !== arg) {
      out.push(pair);
      continue;
    }
    out.push(redactBearer(redactUrl(arg)));
  }
  return out;
}

/** URL query values of secret-looking parameters masked. */
export function redactUrl(value: string): string {
  if (!/^https?:\/\//.test(value)) return value;
  try {
    const url = new URL(value);
    let changed = false;
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_FLAG.test(key)) {
        url.searchParams.set(key, "••••");
        changed = true;
      }
    }
    if (url.password !== "") {
      url.password = "••••";
      changed = true;
    }
    return changed ? url.toString() : value;
  } catch {
    return value;
  }
}
