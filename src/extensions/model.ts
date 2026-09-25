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
    if (url.password !== "") throw new ExtensionError(400, "credentials in the URL are not allowed");
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

/**
 * Hash of everything an extension would run: its kind, source, server
 * definitions (including bundled ones read from disk) and hook commands.
 * Approving (enabling) records it; a change needs a new approval.
 */
export function fingerprint(ext: Pick<Extension, "kind" | "source" | "runs" | "env">, what: WhatItRuns): string {
  const payload = JSON.stringify({
    kind: ext.kind,
    source: ext.source,
    runs: ext.runs ?? null,
    env: [...(ext.env ?? [])].sort(),
    servers: what.servers.map((s) => ({ ...s, env: [...s.env].sort() })),
    hooks: what.hooks,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

// ---- redaction (discovery shows other tools' configs) -------------------------------

const SECRET_FLAG = /(token|key|secret|password|passwd|auth|credential|bearer)/i;
const SECRET_VALUE = /^(sk-|sk_|ghp_|gho_|ghs_|github_pat_|glpat-|xox[abprs]-|AKIA|AIza|ya29\.|eyJ)[A-Za-z0-9._-]{8,}|^[A-Fa-f0-9]{32,}$|^[A-Za-z0-9+/_-]{40,}={0,2}$/;

/** Args with likely secrets masked: values of --token/--api-key-style flags and token-looking strings. */
export function redactArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const eq = /^(--?[A-Za-z0-9_-]+)=(.*)$/.exec(arg);
    if (eq !== null && SECRET_FLAG.test(eq[1] ?? "")) {
      out.push(`${eq[1]}=••••`);
      continue;
    }
    const prev = args[i - 1] ?? "";
    if (i > 0 && /^--?[A-Za-z0-9_-]+$/.test(prev) && SECRET_FLAG.test(prev) && !arg.startsWith("-")) {
      out.push("••••");
      continue;
    }
    out.push(SECRET_VALUE.test(arg) && !arg.includes("/") ? "••••" : redactUrl(arg));
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
