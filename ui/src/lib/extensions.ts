// Client for the daemon's extensions endpoints (CONTRACTS.md §17): skills, MCP servers, Kiro
// powers, plugins and rules for the agents Ruah runs. Self-contained on purpose (types mirror
// src/contracts/extensions.ts) so the Extensions page can move with whatever layout hosts it.
// Secret values pass through here only on "Save" (POST /api/extensions/secret) and are never
// kept in state, echoed or logged.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useDaemonSelector } from "./daemon";

// ---- types (mirror src/contracts/extensions.ts) -------------------------------------------

export const EXTENSION_KINDS = ["skill", "mcp", "power", "plugin", "rule"] as const;
export type ExtensionKind = (typeof EXTENSION_KINDS)[number];
export type ExtensionScope = "global" | "project";
export const EXTENSION_AGENTS = ["claude", "cursor", "grok", "kiro", "opencode"] as const;
export type ExtensionAgent = (typeof EXTENSION_AGENTS)[number];
export type InstallTarget = "claude-code" | "cursor" | "kiro";
export type Delivery = "session" | "install" | "partial" | "none";
export type ExtensionStatus = "ready" | "missing" | "review" | "invalid";

export type McpRuns =
  | { type: "stdio"; command: string; args: string[] }
  | { type: "http" | "sse"; url: string; headers?: string[] };

export type ExtensionSource =
  | { type: "local"; path: string }
  | { type: "git"; url: string; ref?: string; subdir?: string }
  | { type: "featured"; id: string }
  | { type: "inline" };

export interface ServerPreview {
  name: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  env: string[];
  headers?: string[];
}

export interface WhatItRuns {
  servers: ServerPreview[];
  hooks: string[];
  files: string[];
  launcher: boolean;
}

export interface SupportInfo {
  delivery: Delivery;
  note: string;
}

export interface InstallRecord {
  target: InstallTarget;
  scope: ExtensionScope;
  path: string;
  type: "json-key" | "copy" | "claude-cli";
  key?: string[];
  sha256?: string;
  at: string;
}

export interface ExtensionView {
  id: string;
  kind: ExtensionKind;
  name: string;
  description?: string;
  source: ExtensionSource;
  enabledFor: string[];
  runs?: McpRuns;
  env?: string[];
  notes?: string;
  homepage?: string;
  addedAt: string;
  /** "Also install into" writes made from this machine (kept on this machine only). */
  installedInto?: InstallRecord[];
  scope: ExtensionScope;
  path?: string;
  status: ExtensionStatus;
  statusDetail?: string;
  what: WhatItRuns;
  secrets: { name: string; set: boolean; fromEnv: boolean }[];
  support: Record<ExtensionAgent, SupportInfo>;
  /** What an approval covers; sent back with enable so a change in between is refused, not approved unseen. */
  fingerprint: string;
}

export interface FeaturedExtension {
  id: string;
  kind: ExtensionKind;
  name: string;
  description: string;
  category: string;
  homepage?: string;
  runs?: McpRuns;
  env?: string[];
  optionalEnv?: string[];
  notes?: string;
  suggestedFor?: ExtensionAgent[];
  /** Built into that agent: nothing to add (notes say how to turn it on). */
  builtin?: ExtensionAgent;
  added?: boolean;
}

export interface DiscoveredItem {
  kind: ExtensionKind;
  name: string;
  scope: ExtensionScope;
  source: string;
  description?: string;
  runs?: ServerPreview;
  enabled?: boolean;
}

export interface AgentDiscovery {
  id: ExtensionAgent;
  name: string;
  installed: boolean;
  looked: string[];
  items: DiscoveredItem[];
  errors: string[];
}

export interface SessionPreview {
  agent: ExtensionAgent;
  servers: ServerPreview[];
  plugins: string[];
  skills: string[];
  rules: string[];
  skipped: { id: string; reason: string }[];
  notes: string[];
}

export interface ExtensionsResponse {
  project: { id: string; name: string; root: string } | null;
  agents: { id: ExtensionAgent; name: string; installed: boolean }[];
  installed: ExtensionView[];
  errors: { file: string; error: string }[];
  keychain: boolean;
}

export type AddSource =
  | { type: "local"; path: string }
  | { type: "git"; url: string; ref?: string; subdir?: string }
  | { type: "featured"; id: string }
  | { type: "inline"; runs: McpRuns; env?: string[] };

export interface AddRequest {
  scope: ExtensionScope;
  source: AddSource;
  id?: string;
  name?: string;
  kind?: ExtensionKind;
  enableFor?: ExtensionAgent[];
}

// ---- pure helpers (tested in ui/test/extensions.test.ts) -----------------------------------

export const AGENT_LABEL: Record<ExtensionAgent, string> = {
  claude: "Claude Code",
  cursor: "Cursor",
  grok: "Grok",
  kiro: "Kiro",
  opencode: "OpenCode",
};

export const KIND_LABEL: Record<ExtensionKind, string> = {
  skill: "Skill",
  mcp: "MCP server",
  power: "Power",
  plugin: "Plugin",
  rule: "Rule",
};

export const TARGET_LABEL: Record<InstallTarget, string> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  kiro: "Kiro",
};

/** A shell-ish rendering of a command line for display (never executed). */
export function commandLine(command: string, args: readonly string[]): string {
  return [command, ...args].map(quoteArg).join(" ");
}

export function quoteArg(arg: string): string {
  if (arg.length > 0 && /^[A-Za-z0-9_./:@%+=,${}~-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Splits an arguments field like a shell would (quotes, backslash escapes) — only to build an args array. */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let touched = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i] ?? "";
    if (quote !== null) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < input.length) current += input[++i] ?? "";
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      touched = true;
    } else if (ch === "\\" && i + 1 < input.length) {
      current += input[++i] ?? "";
      touched = true;
    } else if (/\s/.test(ch)) {
      if (touched || current.length > 0) out.push(current);
      current = "";
      touched = false;
    } else {
      current += ch;
      touched = true;
    }
  }
  if (touched || current.length > 0) out.push(current);
  return out;
}

/** Comma / space separated env or header names, deduplicated. */
export function splitNames(input: string): string[] {
  return [...new Set(input.split(/[\s,]+/).map((n) => n.trim()).filter((n) => n.length > 0))];
}

export function describeServer(server: ServerPreview): string {
  if (server.transport === "stdio") return commandLine(server.command ?? "", server.args ?? []);
  return `${server.transport.toUpperCase()} ${server.url ?? ""}`;
}

export function matchesQuery(e: { id: string; name: string; description?: string | undefined; kind: string }, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  return [e.id, e.name, e.description ?? "", e.kind, KIND_LABEL[e.kind as ExtensionKind] ?? ""].some((s) => s.toLowerCase().includes(q));
}

/** What a per-agent switch shows for one extension. */
export function agentSwitch(view: ExtensionView, agent: ExtensionAgent): { on: boolean; disabled: boolean; hint: string | null; note: string } {
  const support = view.support[agent];
  const on = view.enabledFor.includes(agent);
  const disabled = support.delivery === "none" || view.status === "missing" || view.status === "invalid";
  const hint = support.delivery === "install" ? "install only" : support.delivery === "partial" ? "partly" : support.delivery === "none" ? "n/a" : null;
  return { on, disabled, hint, note: support.note };
}

/** True when turning an agent on also approves commands / hooks the user has not approved yet. */
export function needsApproval(view: ExtensionView): boolean {
  const runsSomething = view.what.servers.some((s) => s.transport === "stdio") || view.what.hooks.length > 0;
  return runsSomething && (view.enabledFor.length === 0 || view.status === "review");
}

export function sourceLabel(source: ExtensionSource, path?: string): string {
  switch (source.type) {
    case "local":
      return path ?? source.path;
    case "git":
      return `${source.url}${source.ref !== undefined ? `#${source.ref}` : ""}${source.subdir !== undefined ? ` · ${source.subdir}` : ""}`;
    case "featured":
      return "Featured";
    case "inline":
      return "Custom";
  }
}

export function groupByCategory(list: readonly FeaturedExtension[]): { category: string; items: FeaturedExtension[] }[] {
  const order: string[] = [];
  const groups = new Map<string, FeaturedExtension[]>();
  for (const f of list) {
    if (!groups.has(f.category)) {
      groups.set(f.category, []);
      order.push(f.category);
    }
    groups.get(f.category)?.push(f);
  }
  return order.map((category) => ({ category, items: groups.get(category) ?? [] }));
}

// ---- HTTP -------------------------------------------------------------------------------------

export type Result<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

async function call<T>(origin: string | null, method: "GET" | "POST", path: string, body?: unknown): Promise<Result<T>> {
  if (origin === null) return { ok: false, status: 0, message: "No daemon connected" };
  // The daemon accepts changes only from the viewer it serves (same origin, on this machine).
  if (method === "POST" && typeof window !== "undefined" && origin !== window.location.origin) {
    return { ok: false, status: 403, message: "Extensions can be changed only in the Ruah app (the viewer the daemon serves), not in a preview." };
  }
  try {
    const r = await fetch(`${origin}${path}`, {
      method,
      ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    const type = r.headers.get("content-type") ?? "";
    const json = type.includes("json") ? ((await r.json().catch(() => null)) as unknown) : null;
    if (!r.ok) {
      const message = (json as { error?: string } | null)?.error ?? (r.status === 404 ? "This daemon does not serve extensions yet — update Ruah" : `${r.status} ${r.statusText}`);
      return { ok: false, status: r.status, message };
    }
    if (json === null) return { ok: false, status: r.status, message: "This daemon does not serve extensions yet — update Ruah" };
    return { ok: true, data: json as T };
  } catch (err) {
    return { ok: false, status: 0, message: (err as Error).message };
  }
}

export interface ExtensionsApi {
  origin: string | null;
  list: () => Promise<Result<ExtensionsResponse>>;
  featured: () => Promise<Result<{ featured: FeaturedExtension[] }>>;
  discover: () => Promise<Result<{ agents: AgentDiscovery[] }>>;
  preview: (agent: ExtensionAgent) => Promise<Result<SessionPreview>>;
  add: (req: AddRequest) => Promise<Result<{ extension: ExtensionView }>>;
  remove: (id: string, scope: ExtensionScope) => Promise<Result<{ ok: true; notes: string[] }>>;
  /** `fingerprint`: the ExtensionView.fingerprint the user saw (409 when what it runs changed since). */
  enable: (id: string, scope: ExtensionScope, agents: ExtensionAgent[], fingerprint?: string) => Promise<Result<{ extension: ExtensionView }>>;
  disable: (id: string, scope: ExtensionScope, agents?: ExtensionAgent[]) => Promise<Result<{ extension: ExtensionView }>>;
  fetchSource: (id: string, scope: ExtensionScope) => Promise<Result<{ extension: ExtensionView }>>;
  setSecret: (id: string, scope: ExtensionScope, name: string, value: string) => Promise<Result<{ ok: true }>>;
  deleteSecret: (id: string, scope: ExtensionScope, name: string) => Promise<Result<{ ok: true; deleted: boolean }>>;
  installInto: (id: string, scope: ExtensionScope, target: InstallTarget, targetScope: ExtensionScope) => Promise<Result<{ extension: ExtensionView; written: string[]; notes: string[] }>>;
}

export function extensionsApi(origin: string | null): ExtensionsApi {
  return {
    origin,
    list: () => call(origin, "GET", "/api/extensions"),
    featured: () => call(origin, "GET", "/api/extensions/featured"),
    discover: () => call(origin, "GET", "/api/extensions/discover"),
    preview: (agent) => call(origin, "GET", `/api/extensions/preview?agent=${encodeURIComponent(agent)}`),
    add: (req) => call(origin, "POST", "/api/extensions/add", req),
    remove: (id, scope) => call(origin, "POST", "/api/extensions/remove", { id, scope }),
    enable: (id, scope, agents, fingerprint) => call(origin, "POST", "/api/extensions/enable", { id, scope, agents, ...(fingerprint !== undefined ? { fingerprint } : {}) }),
    disable: (id, scope, agents) => call(origin, "POST", "/api/extensions/disable", { id, scope, ...(agents !== undefined ? { agents } : {}) }),
    fetchSource: (id, scope) => call(origin, "POST", "/api/extensions/fetch", { id, scope }),
    setSecret: (id, scope, name, value) => call(origin, "POST", "/api/extensions/secret", { id, scope, name, value }),
    deleteSecret: (id, scope, name) => call(origin, "POST", "/api/extensions/secret/delete", { id, scope, name }),
    installInto: (id, scope, target, targetScope) => call(origin, "POST", "/api/extensions/install-into", { id, scope, target, targetScope }),
  };
}

// ---- React --------------------------------------------------------------------------------------

export type Load<T> = { status: "idle" | "loading" } | { status: "ok"; data: T } | { status: "error"; message: string };

/** The page's data: the installed list (reloaded after every change), the catalog and discovery on demand. */
export function useExtensions() {
  const origin = useDaemonSelector((s) => (s.source === "daemon" ? s.httpOrigin : null));
  const projectId = useDaemonSelector((s) => s.project?.id ?? null);
  const api = useMemo(() => extensionsApi(origin), [origin]);
  const [list, setList] = useState<Load<ExtensionsResponse>>({ status: "idle" });
  const [featured, setFeatured] = useState<Load<FeaturedExtension[]>>({ status: "idle" });
  const [discovery, setDiscovery] = useState<Load<AgentDiscovery[]>>({ status: "idle" });

  const reload = useCallback(async () => {
    if (origin === null) return;
    setList((prev) => (prev.status === "ok" ? prev : { status: "loading" }));
    const r = await api.list();
    setList(r.ok ? { status: "ok", data: r.data } : { status: "error", message: r.message });
  }, [api, origin]);

  const loadFeatured = useCallback(async () => {
    if (origin === null) return;
    setFeatured((prev) => (prev.status === "ok" ? prev : { status: "loading" }));
    const r = await api.featured();
    setFeatured(r.ok ? { status: "ok", data: r.data.featured } : { status: "error", message: r.message });
  }, [api, origin]);

  const loadDiscovery = useCallback(async () => {
    if (origin === null) return;
    setDiscovery((prev) => (prev.status === "ok" ? prev : { status: "loading" }));
    const r = await api.discover();
    setDiscovery(r.ok ? { status: "ok", data: r.data.agents } : { status: "error", message: r.message });
  }, [api, origin]);

  // Project switches change the project-scoped half of everything.
  useEffect(() => {
    setList({ status: "idle" });
    setDiscovery({ status: "idle" });
    void reload();
  }, [reload, projectId]);

  return { api, origin, projectId, list, featured, discovery, reload, loadFeatured, loadDiscovery };
}
