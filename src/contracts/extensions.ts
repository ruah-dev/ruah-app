// src/contracts/extensions.ts — CONTRACTS.md §17: agent extensions (skills,
// MCP servers, Kiro powers, plugins, rules). The stored file format
// ($RUAH_HOME/extensions.json, <repo>/.ruah/extensions.json), the views the
// daemon answers with, and the request bodies of /api/extensions/*. No secret
// value ever appears in any of these shapes: env vars and HTTP headers are
// listed by NAME only (values live in the macOS Keychain).
import { z } from "zod";

export const EXTENSION_KINDS = ["skill", "mcp", "power", "plugin", "rule"] as const;
export type ExtensionKind = (typeof EXTENSION_KINDS)[number];

export const EXTENSION_SCOPES = ["global", "project"] as const;
export type ExtensionScope = (typeof EXTENSION_SCOPES)[number];

/** The agents an extension can be enabled for (the viewer's listed agents, src/acp/presets.ts). */
export const EXTENSION_AGENTS = ["claude", "cursor", "grok", "kiro", "opencode"] as const;
export type ExtensionAgent = (typeof EXTENSION_AGENTS)[number];

/** "Also install into …": tools whose own config Ruah may write to, only on an explicit per-action request. */
export const INSTALL_TARGETS = ["claude-code", "cursor", "kiro"] as const;
export type InstallTarget = (typeof INSTALL_TARGETS)[number];

/** How an agent receives a kind: injected when a session starts, only through "Also install into", partly, or not at all. */
export const DELIVERIES = ["session", "install", "partial", "none"] as const;
export type Delivery = (typeof DELIVERIES)[number];

/** Lower-case slug; also the MCP server name agents see. "ruah" is reserved for the map tools (§1.7). */
export const ExtensionIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,62}$/, "id: lower-case letters, digits, '.', '_' or '-' (at most 63)")
  .refine((id) => id !== "ruah", "id \"ruah\" is reserved for the map tools");

/** POSIX-style variable name (what a server reads from its environment). */
export const EnvNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, "env var names: letters, digits and _");

/** HTTP header name (RFC 7230 token). */
export const HeaderNameSchema = z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/, "invalid header name");

/** What an MCP server runs: a local command (no shell) or a remote endpoint. */
export const McpRunsSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stdio"),
    command: z.string().min(1).max(1024),
    /** `${project}` = the session's repo root, `${home}` = the user's home; nothing else is expanded. */
    args: z.array(z.string().max(4096)).max(64),
  }),
  z.object({
    type: z.literal("http"),
    url: z.string().min(1).max(2048),
    /** Header NAMES whose values come from the Keychain (e.g. "Authorization"). */
    headers: z.array(HeaderNameSchema).max(16).optional(),
  }),
  z.object({
    type: z.literal("sse"),
    url: z.string().min(1).max(2048),
    headers: z.array(HeaderNameSchema).max(16).optional(),
  }),
]);
export type McpRuns = z.infer<typeof McpRunsSchema>;

export const ExtensionSourceSchema = z.discriminatedUnion("type", [
  /** A folder or file on this machine. In a project file, relative to the repo root when inside it. */
  z.object({ type: z.literal("local"), path: z.string().min(1).max(4096) }),
  /** Cloned (depth 1) into $RUAH_HOME/extensions/src/<id>; `subdir` picks a folder inside the clone. */
  z.object({
    type: z.literal("git"),
    url: z.string().min(1).max(2048),
    ref: z.string().max(200).optional(),
    subdir: z.string().max(512).optional(),
  }),
  /** An entry of the curated catalog (src/extensions/featured.json); runs/env are copied at add time. */
  z.object({ type: z.literal("featured"), id: z.string().min(1).max(100) }),
  /** An MCP server defined only by its command or URL. */
  z.object({ type: z.literal("inline") }),
]);
export type ExtensionSource = z.infer<typeof ExtensionSourceSchema>;

/**
 * One "Also install into" write, remembered so Remove can undo exactly it.
 * Kept on this machine only ($RUAH_HOME/extensions-installs.json, keyed by
 * scope + id), never in an extensions file: a record read from a committed
 * project file would let a commit make Remove delete arbitrary config.
 */
export const InstallRecordSchema = z.object({
  target: z.enum(INSTALL_TARGETS),
  scope: z.enum(EXTENSION_SCOPES),
  /** The file or folder written (absolute). */
  path: z.string().max(4096),
  /** "json-key": a key merged into a JSON config; "copy": a folder or file Ruah created; "claude-cli": `claude mcp add-json -s user`. */
  type: z.enum(["json-key", "copy", "claude-cli"]),
  /** For json-key and claude-cli: ["mcpServers", <name>]. */
  key: z.array(z.string().max(200)).max(2).optional(),
  /**
   * What Ruah wrote, so Remove undoes it only while it is unchanged: a copied
   * file's content hash, or (json-key, claude-cli) the hash of the entry.
   */
  sha256: z.string().max(128).optional(),
  at: z.string(),
});
export type InstallRecord = z.infer<typeof InstallRecordSchema>;

export const ExtensionSchema = z.object({
  id: ExtensionIdSchema,
  kind: z.enum(EXTENSION_KINDS),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  source: ExtensionSourceSchema,
  /** Agents it is injected into. Unknown ids are kept but ignored (forward compatible). */
  enabledFor: z.array(z.string().max(40)).max(16),
  /** kind "mcp": the server. */
  runs: McpRunsSchema.optional(),
  /** Env var NAMES the server needs (values: Keychain, else the daemon's environment). */
  env: z.array(EnvNameSchema).max(32).optional(),
  /** Setup notes shown on the card (e.g. "Run /design-login in Claude Code once"). */
  notes: z.string().max(1000).optional(),
  homepage: z.string().max(2048).optional(),
  addedAt: z.string(),
  // No install records here (see InstallRecordSchema); an `installedInto` key in an
  // older file is dropped when it is read.
});
export type Extension = z.infer<typeof ExtensionSchema>;

export const ExtensionsFileSchema = z.object({
  version: z.literal(1),
  extensions: z.array(ExtensionSchema).max(500),
});
export type ExtensionsFile = z.infer<typeof ExtensionsFileSchema>;

// ---- views --------------------------------------------------------------------

/** One MCP server as it will be started (secrets: names only). */
export interface ServerPreview {
  name: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  env: string[];
  headers?: string[];
}

/** "What it runs": everything executable an extension brings, shown before it is enabled. */
export interface WhatItRuns {
  servers: ServerPreview[];
  /**
   * Commands a plugin runs besides its MCP servers, one line each: hooks, LSP
   * servers, monitors, status lines (run by agents that load the plugin:
   * Claude, Cursor, Grok).
   */
  hooks: string[];
  /** Instruction files it provides (SKILL.md, POWER.md, steering, rules), relative to its folder. */
  files: string[];
  /** True when stdio servers start through `ruah app ext exec` (it reads their secrets from the Keychain). */
  launcher: boolean;
}

export interface SupportInfo {
  delivery: Delivery;
  note: string;
}

export type ExtensionStatus = "ready" | "missing" | "review" | "invalid";

export interface ExtensionView extends Extension {
  scope: ExtensionScope;
  /** Resolved folder or file on disk (absent for MCP servers defined by command/URL only). */
  path?: string;
  /** missing: the source folder is gone; review: it changed since it was approved (not injected); invalid: see statusDetail. */
  status: ExtensionStatus;
  statusDetail?: string;
  what: WhatItRuns;
  /** Each declared env var / header: whether the Keychain has a value, whether the daemon's env has one. */
  secrets: { name: string; set: boolean; fromEnv: boolean }[];
  support: Record<ExtensionAgent, SupportInfo>;
  /** What an approval covers (the hash of what it runs now); pass it to enable so a change in between is not approved unseen. */
  fingerprint: string;
  /** "Also install into" writes made from this machine (Remove undoes them). */
  installedInto?: InstallRecord[];
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
  /** Optional env names (the server works without them). */
  optionalEnv?: string[];
  notes?: string;
  /** Agents it is suggested for (the add dialog pre-selects them; nothing is enabled without the user). */
  suggestedFor?: ExtensionAgent[];
  /**
   * Built into that agent: nothing to add (Claude Design is a Claude Code tool
   * that calls its endpoint with Claude's own credentials; a generic MCP client
   * cannot sign in to it). `notes` says how to turn it on.
   */
  builtin?: ExtensionAgent;
  /** Already added (global or this project). */
  added?: boolean;
}

/** Read-only discovery: what an agent already has configured on its own. */
export interface DiscoveredItem {
  kind: ExtensionKind;
  name: string;
  scope: ExtensionScope;
  /** The file it was found in (or the folder). */
  source: string;
  description?: string;
  runs?: ServerPreview;
  /** false when the agent's config marks it disabled. */
  enabled?: boolean;
}

export interface AgentDiscovery {
  id: ExtensionAgent;
  name: string;
  installed: boolean;
  /** Config files / folders looked at (existing or not). */
  looked: string[];
  items: DiscoveredItem[];
  errors: string[];
}

/** What a session of one agent receives right now (GET /api/extensions/preview). */
export interface SessionPreview {
  agent: ExtensionAgent;
  servers: ServerPreview[];
  /** Plugin folders passed to the agent (Claude SDK `plugins`, `--plugin-dir`). */
  plugins: string[];
  /** Skill folders (Ruah's generated plugin, OpenCode skills.paths). */
  skills: string[];
  rules: string[];
  /** Extensions enabled for the agent that are skipped, and why. */
  skipped: { id: string; reason: string }[];
  notes: string[];
}

export interface ExtensionsResponse {
  project: { id: string; name: string; root: string } | null;
  agents: { id: ExtensionAgent; name: string; installed: boolean }[];
  installed: ExtensionView[];
  /** Files that could not be read (invalid JSON, schema errors) — never overwritten. */
  errors: { file: string; error: string }[];
  keychain: boolean;
}

// ---- request bodies -----------------------------------------------------------

const AgentListSchema = z.array(z.enum(EXTENSION_AGENTS)).max(EXTENSION_AGENTS.length);

export const AddExtensionBodySchema = z.object({
  scope: z.enum(EXTENSION_SCOPES).default("global"),
  source: z.discriminatedUnion("type", [
    z.object({ type: z.literal("local"), path: z.string().min(1).max(4096) }),
    z.object({ type: z.literal("git"), url: z.string().min(1).max(2048), ref: z.string().max(200).optional(), subdir: z.string().max(512).optional() }),
    z.object({ type: z.literal("featured"), id: z.string().min(1).max(100) }),
    z.object({ type: z.literal("inline"), runs: McpRunsSchema, env: z.array(EnvNameSchema).max(32).optional() }),
  ]),
  id: ExtensionIdSchema.optional(),
  name: z.string().min(1).max(120).optional(),
  kind: z.enum(EXTENSION_KINDS).optional(),
  /**
   * Enable for these agents (the user picked them in the add dialog). Approved
   * right away only when the request itself says what runs (an MCP command or
   * URL, a featured entry) or it runs nothing; a folder or git source that runs
   * commands stays in review until approved with its fingerprint.
   */
  enableFor: AgentListSchema.optional(),
});
export type AddExtensionBody = z.infer<typeof AddExtensionBodySchema>;

export const ExtensionRefBodySchema = z.object({
  id: ExtensionIdSchema,
  scope: z.enum(EXTENSION_SCOPES),
});

export const EnableExtensionBodySchema = ExtensionRefBodySchema.extend({
  agents: AgentListSchema.min(1),
  /** The fingerprint the user reviewed (ExtensionView.fingerprint); 409 when what it runs changed since. */
  fingerprint: z.string().max(128).optional(),
});
export const DisableExtensionBodySchema = ExtensionRefBodySchema.extend({ agents: AgentListSchema.optional() });
export const RemoveExtensionBodySchema = ExtensionRefBodySchema.extend({
  /** Also undo its "Also install into" writes (default true). */
  uninstall: z.boolean().optional(),
});

export const SetSecretBodySchema = ExtensionRefBodySchema.extend({
  name: z.string().min(1).max(128),
  /** Sent once, stored in the Keychain, never echoed or logged. */
  value: z.string().min(1).max(8192),
});
export const DeleteSecretBodySchema = ExtensionRefBodySchema.extend({ name: z.string().min(1).max(128) });

export const InstallIntoBodySchema = ExtensionRefBodySchema.extend({
  target: z.enum(INSTALL_TARGETS),
  /** Where in the target: its user-wide config or the open project's. */
  targetScope: z.enum(EXTENSION_SCOPES),
});
