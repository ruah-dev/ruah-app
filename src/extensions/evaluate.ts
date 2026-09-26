// src/extensions/evaluate.ts — one extension as it is on disk right now: its
// folder, what it runs (servers, hooks, instruction files), the fingerprint of
// that, and whether it may be injected (status). Used by the views, the
// session resolver and the CLI alike, so "what it runs" is always exactly
// what a session gets.
import * as fs from "node:fs";
import type { Extension, ExtensionScope, ExtensionStatus, McpRuns, WhatItRuns } from "../contracts/extensions.js";
import { inspectPath, whatOf, type BundledServer, type Inspection } from "./inspect.js";
import { ExtensionError, fingerprint, scopeKeyOf, slugify, validateMcpUrl } from "./model.js";
import type { ExtensionsStore } from "./store.js";

export interface Evaluated {
  ext: Extension;
  scope: ExtensionScope;
  scopeKey: string;
  path?: string;
  inspection?: Inspection;
  /** Effective MCP servers (inline runs, a folder's .mcp.json, a power's / plugin's bundled servers). */
  servers: BundledServer[];
  what: WhatItRuns;
  fingerprint: string;
  status: ExtensionStatus;
  statusDetail?: string;
}

function serverName(ext: Extension, name: string, count: number): string {
  if (ext.kind === "mcp" && count === 1) return ext.id;
  return slugify(`${ext.id}-${name}`);
}

function inlineServer(ext: Extension, runs: McpRuns): BundledServer {
  return {
    name: ext.id,
    runs,
    env: [...(ext.env ?? [])],
    envValues: {},
    headerValues: {},
  };
}

export function evaluate(store: ExtensionsStore, ext: Extension, scope: ExtensionScope, root: string | undefined, projectId: string | undefined): Evaluated {
  const scopeKey = scopeKeyOf(scope, projectId);
  const target = store.resolvePath(ext.source, scope, root);
  let inspection: Inspection | undefined;
  let status: ExtensionStatus = "ready";
  let statusDetail: string | undefined;

  if (target !== undefined) {
    if (!fs.existsSync(target)) {
      status = "missing";
      statusDetail = ext.source.type === "git" ? "not fetched on this machine yet" : `not found: ${target}`;
    } else {
      try {
        inspection = inspectPath(target, ext.kind);
      } catch (err) {
        status = "invalid";
        statusDetail = err instanceof ExtensionError ? err.message : (err as Error).message;
      }
    }
  }

  let servers: BundledServer[] = [];
  if (ext.runs !== undefined) servers = [inlineServer(ext, ext.runs)];
  else if (inspection !== undefined) {
    const bundled = inspection.servers;
    servers = bundled.map((s) => ({
      ...s,
      name: serverName(ext, s.name, bundled.length),
      // Declared names on the extension add to what the file lists (e.g. a secret the server reads).
      env: [...new Set([...s.env, ...(ext.kind === "mcp" ? (ext.env ?? []) : [])])],
    }));
  } else if (ext.kind === "mcp" && status === "ready") {
    status = "invalid";
    statusDetail = "no server command or URL";
  }

  // Remote servers read from a folder (.mcp.json, a power's mcp.json, a plugin) get the same URL
  // rule as inline ones: https, or http only on loopback.
  if (status === "ready") {
    for (const server of servers) {
      if (server.runs.type === "stdio") continue;
      try {
        validateMcpUrl(server.runs.url);
      } catch (err) {
        status = "invalid";
        statusDetail = `${server.name}: ${(err as Error).message}`;
        break;
      }
    }
  }

  const launcher = servers.some((s) => s.runs.type === "stdio" && s.env.some((name) => s.envValues[name] === undefined || /\$\{/.test(s.envValues[name] ?? "")));
  const base = whatOf(inspection, launcher);
  const what: WhatItRuns = {
    ...base,
    servers: servers.map((s) => ({
      name: s.name,
      transport: s.runs.type,
      ...(s.runs.type === "stdio" ? { command: s.runs.command, args: [...s.runs.args] } : { url: s.runs.url }),
      env: [...s.env],
      ...(s.runs.type !== "stdio" && s.runs.headers !== undefined ? { headers: [...s.runs.headers] } : {}),
    })),
  };
  const fp = fingerprint(ext, what, { servers, ...(inspection?.digest !== undefined ? { digest: inspection.digest } : {}) });

  if (status === "ready" && ext.enabledFor.length > 0) {
    const approved = store.approvedFingerprint(scopeKey, ext.id);
    if (approved === undefined) {
      status = "review";
      statusDetail = scope === "project" ? "enabled in the project file but not approved on this machine" : "not approved on this machine";
    } else if (approved !== fp) {
      status = "review";
      statusDetail = "what it runs changed since you enabled it";
    }
  }

  return {
    ext,
    scope,
    scopeKey,
    ...(target !== undefined ? { path: target } : {}),
    ...(inspection !== undefined ? { inspection } : {}),
    servers,
    what,
    fingerprint: fp,
    status,
    ...(statusDetail !== undefined ? { statusDetail } : {}),
  };
}
