// src/extensions/service.ts — ExtensionsService: the one API the daemon
// (/api/extensions/*), the CLI (`ruah app ext …`) and the bridges use.
// Rules it enforces (CONTRACTS §17.4):
//   - adding never runs anything (a git source is only cloned);
//   - an extension reaches an agent only after the user enabled it for that
//     agent, which records the fingerprint of what it runs; a change (edited
//     .mcp.json, pulled commit, someone else's project file) needs a new approval;
//   - secret VALUES only go to the Keychain; files hold names;
//   - other tools' configs are written only by installInto(), per request, and
//     undone only from this machine's records (never from a project file).
import { realpathSync } from "node:fs";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import {
  EXTENSION_AGENTS,
  ExtensionSchema,
  type AddExtensionBody,
  type AgentDiscovery,
  type Extension,
  type ExtensionAgent,
  type ExtensionScope,
  type ExtensionView,
  type ExtensionsResponse,
  type FeaturedExtension,
  type InstallTarget,
  type SessionPreview,
} from "../contracts/extensions.js";
import type { AcpPreset, AgentExtensions, SessionExtensions } from "../acp/bridge.js";
import { agentDefinition } from "../acp/presets.js";
import type { Runner } from "../integrations/exec.js";
import { Keychain, type SecretStore } from "../integrations/keychain.js";
import { projectIdFor } from "../projects/fs-util.js";
import { supportFor, supportMatrix, withPluginDirs } from "./agents.js";
import { discoverAgents } from "./discover.js";
import { evaluate, type Evaluated } from "./evaluate.js";
import { featuredCatalog, featuredEntry } from "./featured.js";
import { cloneSource } from "./git.js";
import { inspectPath } from "./inspect.js";
import { installInto, uninstallRecords, type InstallResult } from "./install-into.js";
import {
  AGENT_NAMES,
  ExtensionError,
  extensionAgentFor,
  safeSubpath,
  scopeKeyOf,
  secretAccount,
  slugify,
  validateGitUrl,
  validateRuns,
} from "./model.js";
import { resolveSession, type Launch, type ResolvedSession } from "./resolve.js";
import { ExtensionsStore } from "./store.js";

export interface ProjectRef {
  id: string;
  root: string;
  name: string;
}

export interface ExtensionsServiceOptions {
  home: string;
  /** Default: the macOS Keychain (service "ruah"). */
  secrets?: SecretStore;
  /** git (clone) and the Claude Code CLI (install into). */
  runner?: Runner;
  /** How agents start `ruah app ext exec` (default: this process's node + CLI entry). */
  launch?: () => Launch;
  env?: NodeJS.ProcessEnv;
  /** Tests clone file:// fixtures. */
  allowFileGit?: boolean;
  claudeBin?: string;
  now?: () => Date;
}

/** node + the running CLI (dev: tsx loader flags; desktop: Electron as node) — same as the map tools' launch. */
export function defaultLaunch(): Launch {
  const entry = process.argv[1] !== undefined ? realpathSync(process.argv[1]) : "ruah-app";
  return {
    command: process.execPath,
    args: [...process.execArgv, entry],
    ...(process.env.ELECTRON_RUN_AS_NODE !== undefined ? { env: { ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE } } : {}),
  };
}

/** The project a folder belongs to (CONTRACTS §5.1 id). */
export function projectRefFor(root: string): ProjectRef {
  let real = path.resolve(root);
  try {
    real = realpathSync(real);
  } catch {
    // keep the resolved path
  }
  return { id: projectIdFor(real), root: real, name: path.basename(real) };
}

export class ExtensionsService {
  readonly store: ExtensionsStore;
  private readonly secrets: SecretStore;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly options: ExtensionsServiceOptions) {
    this.store = new ExtensionsStore(options.home);
    this.secrets = options.secrets ?? new Keychain();
    this.env = options.env ?? process.env;
  }

  private now(): string {
    return (this.options.now ?? (() => new Date()))().toISOString();
  }

  private root(scope: ExtensionScope, project: ProjectRef | undefined): string | undefined {
    if (scope === "project" && project === undefined) throw new ExtensionError(409, "no project is open");
    return project?.root;
  }

  /** The open project, unless its .ruah folder is Ruah's home (then its extensions file is the global one). */
  private usable(project: ProjectRef | undefined): ProjectRef | undefined {
    return project !== undefined && this.store.isProjectRoot(project.root) ? project : undefined;
  }

  private evaluateRef(id: string, scope: ExtensionScope, project: ProjectRef | undefined): Evaluated {
    const root = this.root(scope, project);
    const ext = this.store.get(scope, root, id);
    if (ext === undefined) throw new ExtensionError(404, `no ${scope} extension "${id}"`);
    return evaluate(this.store, ext, scope, project?.root, project?.id);
  }

  // ---- views ------------------------------------------------------------------------

  private async secretStatus(ev: Evaluated): Promise<ExtensionView["secrets"]> {
    const names = new Set<string>();
    for (const server of ev.servers) {
      for (const name of server.env) if (server.envValues[name] === undefined || /\$\{/.test(server.envValues[name] ?? "")) names.add(name);
      if (server.runs.type !== "stdio") for (const header of server.runs.headers ?? []) if (server.headerValues[header] === undefined) names.add(header);
    }
    const out: ExtensionView["secrets"] = [];
    for (const name of names) {
      let set = false;
      try {
        set = (await this.secrets.get(secretAccount(ev.scopeKey, ev.ext.id, name))) !== null;
      } catch {
        set = false;
      }
      const envValue = this.env[name];
      out.push({ name, set, fromEnv: envValue !== undefined && envValue.length > 0 });
    }
    return out;
  }

  async view(ev: Evaluated): Promise<ExtensionView> {
    const runs = ev.ext.runs ?? ev.servers[0]?.runs;
    const support = supportMatrix(ev.ext.kind, ev.ext.kind === "mcp" ? runs : undefined);
    // Cursor / Grok load a plugin folder themselves: its servers read secrets from their own environment.
    if (ev.ext.kind === "plugin" && ev.servers.some((s) => secretNames(s).length > 0)) {
      for (const agent of ["cursor", "grok"] as const) {
        support[agent] = { ...support[agent], note: `${support[agent].note}. Its MCP servers read ${[...new Set(ev.servers.flatMap(secretNames))].join(", ")} from ${AGENT_NAMES[agent]}'s own environment, not from the Keychain` };
      }
    }
    const installs = this.store.installs(ev.scopeKey, ev.ext.id);
    return {
      ...ev.ext,
      scope: ev.scope,
      ...(ev.path !== undefined ? { path: ev.path } : {}),
      status: ev.status,
      ...(ev.statusDetail !== undefined ? { statusDetail: ev.statusDetail } : {}),
      what: ev.what,
      secrets: await this.secretStatus(ev),
      support,
      fingerprint: ev.fingerprint,
      ...(installs.length > 0 ? { installedInto: installs } : {}),
    };
  }

  async list(projectRef: ProjectRef | undefined): Promise<ExtensionsResponse> {
    const project = this.usable(projectRef);
    const errors: ExtensionsResponse["errors"] = [];
    const installed: ExtensionView[] = [];
    const global = this.store.read("global");
    if (global.error !== undefined) errors.push({ file: global.file, error: global.error });
    for (const ext of global.extensions) installed.push(await this.view(evaluate(this.store, ext, "global", project?.root, project?.id)));
    if (project !== undefined) {
      const local = this.store.read("project", project.root);
      if (local.error !== undefined) errors.push({ file: local.file, error: local.error });
      for (const ext of local.extensions) installed.push(await this.view(evaluate(this.store, ext, "project", project.root, project.id)));
    }
    return {
      project: project !== undefined ? { id: project.id, name: project.name, root: project.root } : null,
      agents: EXTENSION_AGENTS.map((id) => ({ id, name: AGENT_NAMES[id], installed: id === "claude" || agentDefinition(id)?.preset(this.env) !== undefined })),
      installed,
      errors,
      keychain: process.platform === "darwin" || this.options.secrets !== undefined,
    };
  }

  featured(projectRef: ProjectRef | undefined): FeaturedExtension[] {
    const project = this.usable(projectRef);
    const added = new Set<string>();
    for (const e of this.store.read("global").extensions) if (e.source.type === "featured") added.add(e.source.id);
    if (project !== undefined) for (const e of this.store.read("project", project.root).extensions) if (e.source.type === "featured") added.add(e.source.id);
    return featuredCatalog().map((f) => ({ ...f, added: added.has(f.id) }));
  }

  discover(project: ProjectRef | undefined, agents?: readonly ExtensionAgent[]): AgentDiscovery[] {
    return discoverAgents({ root: project?.root, env: this.env, ...(agents !== undefined ? { agents } : {}) });
  }

  // ---- add / remove -------------------------------------------------------------------

  async add(body: AddExtensionBody, project: ProjectRef | undefined, options: { cwd?: string } = {}): Promise<ExtensionView> {
    const scope = body.scope;
    const root = this.root(scope, project);
    const src = body.source;
    let draft: Omit<Extension, "id" | "addedAt" | "enabledFor"> & { id?: string };

    switch (src.type) {
      case "featured": {
        const entry = featuredEntry(src.id);
        if (entry === undefined) throw new ExtensionError(404, `no featured extension "${src.id}"`);
        if (entry.builtin !== undefined) throw new ExtensionError(422, `${entry.name} is built into ${AGENT_NAMES[entry.builtin]}; nothing to add. ${entry.notes ?? ""}`.trim());
        const env = [...(entry.env ?? []), ...(entry.optionalEnv ?? [])];
        draft = {
          id: entry.id,
          kind: entry.kind,
          name: entry.name,
          description: entry.description,
          source: { type: "featured", id: entry.id },
          ...(entry.runs !== undefined ? { runs: validateRuns(entry.runs) } : {}),
          ...(env.length > 0 ? { env } : {}),
          ...(entry.notes !== undefined ? { notes: entry.notes } : {}),
          ...(entry.homepage !== undefined ? { homepage: entry.homepage } : {}),
        };
        break;
      }
      case "inline": {
        const runs = validateRuns(src.runs);
        const label = body.name ?? (runs.type === "stdio" ? path.basename(runs.command) : new URL(runs.url).hostname);
        draft = {
          kind: "mcp",
          name: label,
          source: { type: "inline" },
          runs,
          ...(src.env !== undefined && src.env.length > 0 ? { env: [...new Set(src.env)] } : {}),
        };
        break;
      }
      case "local": {
        const abs = path.resolve(options.cwd ?? process.cwd(), src.path);
        if (!path.isAbsolute(src.path) && options.cwd === undefined) throw new ExtensionError(400, "path must be absolute");
        const storedPath = this.store.storedLocalPath(abs, scope, root);
        // The project file is committable: a folder outside the repo would put this machine's
        // absolute path (user name, home layout) into the client's repo, broken for teammates.
        if (scope === "project" && path.isAbsolute(storedPath)) {
          throw new ExtensionError(
            422,
            "That folder is outside this project, so it cannot be a project extension: .ruah/extensions.json is committed with the repo and would carry this computer's path. Add it for All projects instead, or move the folder into the repo.",
          );
        }
        const inspection = inspectPath(abs, body.kind);
        draft = {
          kind: inspection.kind,
          name: body.name ?? inspection.name ?? path.basename(inspection.root).replace(/\.(md|mdc|txt)$/i, ""),
          ...(inspection.description !== undefined ? { description: inspection.description.slice(0, 2000) } : {}),
          source: { type: "local", path: storedPath },
        };
        break;
      }
      case "git": {
        const url = validateGitUrl(src.url, this.options.allowFileGit === true ? { allowFile: true } : {});
        const dir = this.store.cloneDir(url, src.ref);
        await cloneSource(url, src.ref, dir, { ...(this.options.runner !== undefined ? { runner: this.options.runner } : {}), ...(this.options.allowFileGit === true ? { allowFile: true } : {}) });
        const target = src.subdir !== undefined && src.subdir.length > 0 ? safeSubpath(dir, src.subdir) : dir;
        const inspection = inspectPath(target, body.kind);
        const repoName = url.replace(/\.git$/, "").split(/[/:]/).pop() ?? "extension";
        draft = {
          kind: inspection.kind,
          name: body.name ?? inspection.name ?? (src.subdir !== undefined ? path.basename(src.subdir) : repoName),
          ...(inspection.description !== undefined ? { description: inspection.description.slice(0, 2000) } : {}),
          source: { type: "git", url, ...(src.ref !== undefined ? { ref: src.ref } : {}), ...(src.subdir !== undefined && src.subdir.length > 0 ? { subdir: src.subdir } : {}) },
          ...(/^https:/.test(url) ? { homepage: url.replace(/\.git$/, "") } : {}),
        };
        break;
      }
    }

    const id = body.id ?? draft.id ?? slugify(draft.name);
    const existing = this.store.read(scope, root);
    if (existing.error !== undefined) throw new ExtensionError(409, `${existing.file}: ${existing.error}`);
    if (existing.extensions.some((e) => e.id === id)) throw new ExtensionError(409, `a ${scope} extension "${id}" already exists`);
    const ext: Extension = { ...draft, id, enabledFor: [], addedAt: this.now() } as Extension;
    // Validate the assembled entry against the file schema before writing anything.
    const parsed = ExtensionSchema.safeParse(ext);
    if (!parsed.success) throw new ExtensionError(400, `invalid extension: ${parsed.error.issues[0]?.message ?? "schema error"}`);

    const enableFor = (body.enableFor ?? []).filter((agent) => supportFor(ext.kind, agent, ext.runs).delivery !== "none");
    const stored: Extension = { ...parsed.data, enabledFor: enableFor };
    const ev = evaluate(this.store, stored, scope, project?.root, project?.id);
    if (enableFor.length > 0 && (ev.status === "missing" || ev.status === "invalid")) throw new ExtensionError(409, `${id}: ${ev.statusDetail ?? ev.status}`);
    this.store.update(scope, root, (list) => [...list, stored]);
    // Approve now only what the request itself spelled out (an MCP command or URL, a featured entry)
    // or what runs nothing. A folder or a clone that runs commands stays in review: the user approves
    // it after seeing what it runs (enable with its fingerprint).
    const runsSomething = ev.servers.some((s) => s.runs.type === "stdio") || ev.what.hooks.length > 0;
    const spelledOut = src.type === "inline" || src.type === "featured";
    if (enableFor.length > 0 && (spelledOut || !runsSomething)) this.store.approve(ev.scopeKey, id, ev.fingerprint);
    return this.view(evaluate(this.store, stored, scope, project?.root, project?.id));
  }

  /** Clones a git source that is not on this machine yet (a project file from a teammate). */
  async fetch(id: string, scope: ExtensionScope, project: ProjectRef | undefined): Promise<ExtensionView> {
    const ev = this.evaluateRef(id, scope, project);
    const source = ev.ext.source;
    if (source.type !== "git") throw new ExtensionError(422, `${id} is not a git extension`);
    const url = validateGitUrl(source.url, this.options.allowFileGit === true ? { allowFile: true } : {});
    await cloneSource(url, source.ref, this.store.cloneDir(url, source.ref), {
      ...(this.options.runner !== undefined ? { runner: this.options.runner } : {}),
      ...(this.options.allowFileGit === true ? { allowFile: true } : {}),
    });
    return this.view(this.evaluateRef(id, scope, project));
  }

  async remove(id: string, scope: ExtensionScope, projectRef: ProjectRef | undefined, options: { uninstall?: boolean } = {}): Promise<{ notes: string[] }> {
    const project = scope === "project" ? projectRef : this.usable(projectRef);
    const ev = this.evaluateRef(id, scope, project);
    const notes: string[] = [];
    // Only this machine's records (never anything a project file says was installed).
    const installs = this.store.installs(ev.scopeKey, id);
    if (options.uninstall !== false && installs.length > 0) {
      notes.push(
        ...(await uninstallRecords(installs, {
          ...(this.options.runner !== undefined ? { runner: this.options.runner } : {}),
          claudeBin: this.options.claudeBin,
          home: this.env.HOME ?? homedir(),
          env: this.env,
        })),
      );
    }
    this.store.setInstalls(ev.scopeKey, id, []);
    for (const secret of await this.secretStatus(ev)) {
      if (!secret.set) continue;
      try {
        await this.secrets.delete(secretAccount(ev.scopeKey, id, secret.name));
      } catch {
        notes.push(`could not delete the Keychain item for ${secret.name}`);
      }
    }
    this.store.revoke(ev.scopeKey, id);
    this.store.update(scope, this.root(scope, project), (list) => list.filter((e) => e.id !== id));
    // A clone nothing else here uses is Ruah's own cache: remove it.
    if (ev.ext.source.type === "git") {
      const dir = this.store.cloneDir(ev.ext.source.url, ev.ext.source.ref);
      const stillUsed = [...this.store.read("global").extensions, ...(project !== undefined ? this.store.read("project", project.root).extensions : [])].some(
        (e) => e.source.type === "git" && this.store.cloneDir(e.source.url, e.source.ref) === dir,
      );
      if (!stillUsed && dir.startsWith(this.store.sourcesDir + path.sep)) fs.rmSync(dir, { recursive: true, force: true });
    }
    return { notes };
  }

  // ---- enable / disable -----------------------------------------------------------------

  /**
   * Enables for `agents` and approves what it runs now. `fingerprint`: the one
   * the user reviewed (ExtensionView.fingerprint); a mismatch means it changed
   * in between and is refused (409) instead of approved unseen.
   */
  async enable(id: string, scope: ExtensionScope, agents: readonly ExtensionAgent[], project: ProjectRef | undefined, options: { fingerprint?: string } = {}): Promise<ExtensionView> {
    const ev = this.evaluateRef(id, scope, project);
    if (ev.status === "missing" || ev.status === "invalid") throw new ExtensionError(409, `${id}: ${ev.statusDetail ?? ev.status}`);
    if (options.fingerprint !== undefined && options.fingerprint !== ev.fingerprint) {
      throw new ExtensionError(409, `what ${id} runs changed since it was shown; review it again`);
    }
    const runs = ev.ext.runs ?? ev.servers[0]?.runs;
    for (const agent of agents) {
      if (supportFor(ev.ext.kind, agent, runs).delivery === "none") throw new ExtensionError(422, `${AGENT_NAMES[agent]} cannot use a ${ev.ext.kind}: ${supportFor(ev.ext.kind, agent, runs).note}`);
    }
    const next = [...new Set([...ev.ext.enabledFor, ...agents])];
    this.store.update(scope, this.root(scope, project), (list) => list.map((e) => (e.id === id ? { ...e, enabledFor: next } : e)));
    this.store.approve(ev.scopeKey, id, ev.fingerprint);
    return this.view(this.evaluateRef(id, scope, project));
  }

  /** Disables for `agents` (absent: all). */
  async disable(id: string, scope: ExtensionScope, agents: readonly ExtensionAgent[] | undefined, project: ProjectRef | undefined): Promise<ExtensionView> {
    const ev = this.evaluateRef(id, scope, project);
    const next = agents === undefined ? [] : ev.ext.enabledFor.filter((a) => !(agents as readonly string[]).includes(a));
    this.store.update(scope, this.root(scope, project), (list) => list.map((e) => (e.id === id ? { ...e, enabledFor: next } : e)));
    return this.view(this.evaluateRef(id, scope, project));
  }

  // ---- secrets ------------------------------------------------------------------------------

  private declaredSecret(ev: Evaluated, name: string): void {
    const declared = ev.servers.some((s) => s.env.includes(name) || (s.runs.type !== "stdio" && (s.runs.headers ?? []).includes(name)));
    if (!declared) throw new ExtensionError(400, `${ev.ext.id} does not use ${name}`);
  }

  async setSecret(id: string, scope: ExtensionScope, name: string, value: string, project: ProjectRef | undefined): Promise<void> {
    const ev = this.evaluateRef(id, scope, project);
    this.declaredSecret(ev, name);
    try {
      await this.secrets.set(secretAccount(ev.scopeKey, id, name), value);
    } catch (err) {
      throw new ExtensionError(503, (err as Error).message);
    }
  }

  async deleteSecret(id: string, scope: ExtensionScope, name: string, project: ProjectRef | undefined): Promise<boolean> {
    const ev = this.evaluateRef(id, scope, project);
    this.declaredSecret(ev, name);
    try {
      return await this.secrets.delete(secretAccount(ev.scopeKey, id, name));
    } catch (err) {
      throw new ExtensionError(503, (err as Error).message);
    }
  }

  // ---- also install into ------------------------------------------------------------------------

  async installInto(id: string, scope: ExtensionScope, target: InstallTarget, targetScope: ExtensionScope, project: ProjectRef | undefined): Promise<InstallResult & { extension: ExtensionView }> {
    const ev = this.evaluateRef(id, scope, project);
    if (ev.status === "review") throw new ExtensionError(409, `${id} needs review (${ev.statusDetail ?? "not approved"}); approve what it runs first`);
    if (targetScope === "project" && this.usable(project) === undefined) throw new ExtensionError(409, "no project is open");
    const previous = this.store.installs(ev.scopeKey, id);
    const result = await installInto(ev, {
      target,
      targetScope,
      root: project?.root,
      home: this.env.HOME ?? homedir(),
      env: this.env,
      previous,
      ...(this.options.runner !== undefined ? { runner: this.options.runner } : {}),
      claudeBin: this.options.claudeBin,
      ...(this.options.now !== undefined ? { now: this.options.now } : {}),
    });
    const records = [...previous.filter((r) => !result.records.some((n) => n.path === r.path && JSON.stringify(n.key) === JSON.stringify(r.key))), ...result.records].slice(-32);
    this.store.setInstalls(ev.scopeKey, id, records);
    return { ...result, extension: await this.view(this.evaluateRef(id, scope, project)) };
  }

  // ---- sessions ------------------------------------------------------------------------------------

  resolveFor(agent: ExtensionAgent, projectRef: ProjectRef | undefined, options: { viaAcp?: boolean; preview?: boolean } = {}): Promise<ResolvedSession> {
    const project = this.usable(projectRef);
    return resolveSession({
      store: this.store,
      agent,
      ...(options.viaAcp === true ? { viaAcp: true } : {}),
      ...(options.preview === true ? { preview: true } : {}),
      root: project?.root,
      projectId: project?.id,
      secrets: this.secrets,
      launch: this.options.launch ?? defaultLaunch,
      env: this.env,
    });
  }

  /** What a session would get (GET /preview, `ext preview`): never prunes generated folders sessions may use. */
  async preview(agent: ExtensionAgent, project: ProjectRef | undefined): Promise<SessionPreview> {
    return (await this.resolveFor(agent, project, { preview: true })).preview;
  }

  /** What a bridge for `agentId` in `root` calls when a session starts (AgentCatalog `extensions`). */
  providerFor(agentId: string, root: string): AgentExtensions | undefined {
    const agent = extensionAgentFor(agentId);
    if (agent === undefined) return undefined;
    const viaAcp = agentId === "claude-acp";
    return {
      resolve: async (preset?: AcpPreset): Promise<SessionExtensions> => {
        try {
          const resolved = await this.resolveFor(agent, projectRefFor(root), { viaAcp });
          const notes = [...resolved.preview.notes, ...resolved.preview.skipped.map((s) => `${s.id} skipped: ${s.reason}`)];
          if (agent === "claude" && !viaAcp) {
            return {
              sdk: {
                mcpServers: resolved.claude.mcpServers,
                plugins: resolved.claude.plugins,
                ...(resolved.claude.pluginsWithoutMcp.length > 0 ? { pluginsWithoutMcp: resolved.claude.pluginsWithoutMcp } : {}),
                ...(resolved.claude.systemPromptAppend !== undefined ? { append: resolved.claude.systemPromptAppend } : {}),
              },
              notes,
            };
          }
          const adapted: AcpPreset | undefined =
            preset !== undefined && (resolved.acp.pluginDirs.length > 0 || Object.keys(resolved.acp.env).length > 0)
              ? { command: preset.command, args: withPluginDirs(agent, preset.args, resolved.acp.pluginDirs), env: { ...(preset.env ?? {}), ...resolved.acp.env } }
              : undefined;
          return { acp: { mcpServers: resolved.acp.mcpServers, ...(adapted !== undefined ? { preset: adapted } : {}) }, notes };
        } catch (err) {
          return { notes: [`extensions unavailable: ${(err as Error).message}`] };
        }
      },
    };
  }
}

/** Env names a server needs from outside its file (Keychain / environment), i.e. without a literal value. */
function secretNames(server: Evaluated["servers"][number]): string[] {
  return server.env.filter((name) => server.envValues[name] === undefined || /\$\{/.test(server.envValues[name] ?? ""));
}

export function scopeKeyFor(scope: ExtensionScope, project: ProjectRef | undefined): string {
  return scopeKeyOf(scope, project?.id);
}
