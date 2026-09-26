// src/projects/service.ts — CONTRACTS §5.3: open / create / pin / forget
// projects and list recent chats. Opening resolves the folder (realpath, must
// be a directory), scans it when there is no architecture.json, loads the
// store and hands it to the host (the SessionHub), which swaps projects at
// runtime. Folders holding ruah.system.json open as multi-repo systems via an
// injectable hook (src/system/* is wired by the lead; the default refuses).
// Opens and creates run one at a time.
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import type { Architecture } from "../contracts/architecture.js";
import type { ChatInfo, ProjectInfo, TurnRecord } from "../contracts/ws.js";
import type { CreateProjectBody, CreateReport, NewProjectCheck, NewProjectDefaults, ProjectsList, RecentChat, ToolStatus } from "../contracts/projects.js";
import { validateArchitecture } from "../contracts/validate.js";
import { createArchitectureStore, type ArchitectureStore } from "../serve/architecture-store.js";
import type { ProjectRuntime } from "../serve/session.js";
import { scanRepo } from "../scan/index.js";
import { atomicWriteFileSync, expandHome, projectIdFor } from "./fs-util.js";
import type { ProjectsStore } from "./projects-store.js";
import { toChatInfo, type ChatStore } from "./chat-store.js";
import type { ProjectScanOptions } from "./project-state.js";
import { checkNewProject, createProjectFolder, ghToolStatus, gitToolStatus, suggestParentDir, type CreateDeps } from "./create.js";
import { templateInfos } from "./templates/index.js";
import type { ProjectsOverview } from "../contracts/overview.js";
import { ProjectError } from "./project-names.js";

export { emptyArchitecture, plainNameProblem, ProjectError, validateProjectName } from "./project-names.js";

export const SYSTEM_FILE = "ruah.system.json";
export const ARCHITECTURE_FILE = "architecture.json";

/** A multi-repo system opened from the folder holding ruah.system.json. */
export interface SystemProject {
  store: ArchitectureStore;
  name?: string;
}
export type OpenSystemProject = (root: string) => Promise<SystemProject>;

/** Default hook until src/system/* is wired: refuses with a clear message. */
export const openSystemProjectNotWired: OpenSystemProject = (root) =>
  Promise.reject(new ProjectError(501, `multi-repo systems are not wired yet (${path.join(root, SYSTEM_FILE)})`));

/** Where opened projects go: the SessionHub. */
export interface ProjectHost {
  setProject(runtime: ProjectRuntime | null): void;
  project(): ProjectInfo | null;
  /** Makes a chat of the open project active (open with `chatId` on the project that is already open). */
  openChat?(chatId: string): void;
  /** The open project's store (previews of the current project). */
  readonly store?: ArchitectureStore | null;
}

/** GET /api/projects/preview: what the viewer needs to paint a project before switching to it. */
export interface ProjectPreview {
  project: ProjectInfo;
  /** Stored architecture.json (null for systems that are not open, or when missing/invalid). */
  architecture: Architecture | null;
  chats: ChatInfo[];
  /** The chat the project opens on (persisted, §5.5). */
  activeChatId: string | null;
  /** That chat's turns, so the chat paints at once too. */
  activeTurns: TurnRecord[];
}

/** Project ids are sha1 prefixes; anything else never reaches a path. */
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export function isProjectId(id: string): boolean {
  return PROJECT_ID.test(id);
}

export interface ProjectServiceDeps {
  projects: ProjectsStore;
  chats: ChatStore;
  host: ProjectHost;
  version: string;
  openSystemProject?: OpenSystemProject;
  /** Watch architecture.json for changes (default true). */
  watch?: boolean;
  info?: (line: string) => void;
  /** §20 create: git / gh runner, env and executable lookup (tests); default execFile without a shell. */
  create?: Omit<Partial<CreateDeps>, "version">;
  /** §20: the remembered "create projects in" folder ($RUAH_HOME/settings.json `newProject.parentDir`). */
  newProjectParent?: { get(): string | undefined; set(dir: string): void };
  /** §20: the recent list changed without a switch (pin, reorder, tags, forget) — the daemon broadcasts it. */
  onListChanged?: (recent: ProjectInfo[]) => void;
  /** §20.5 GET /api/projects/overview (src/projects/overview.ts, wired by the daemon). */
  overview?: { overview(limit?: number): Promise<ProjectsOverview>; invalidate(): void };
}

export interface OpenResult {
  project: ProjectInfo;
  /** Time spent in open (resolve, scan, load, switch), excluding agent startup. */
  ms: number;
  scanned: boolean;
  /** §20: what create did (create only). */
  created?: CreateReport;
}

const GH_STATUS_TTL_MS = 60_000;

/** architecture.json of a project that is not open (preview only; invalid or missing = null). */
function readArchitecture(file: string): Architecture | null {
  try {
    const result = validateArchitecture(JSON.parse(fs.readFileSync(file, "utf8")), null);
    return result.ok ? result.value : null;
  } catch {
    return null;
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export class ProjectService {
  private queue: Promise<unknown> = Promise.resolve();
  private ghStatus: { at: number; value: Promise<NonNullable<ToolStatus["gh"]>> } | undefined;

  constructor(private readonly deps: ProjectServiceDeps) {}

  list(): ProjectsList {
    // Folders that were deleted or moved (temp dirs, old clones) are hidden, not
    // forgotten: an unmounted drive comes back when it is mounted again.
    const recent = this.deps.projects.list().filter((p) => fs.existsSync(p.root));
    return { current: this.deps.host.project(), recent };
  }

  /**
   * Opens a folder as the current project (see file header). `file` overrides
   * <root>/architecture.json; `chatId` opens the project on that chat (one
   * step instead of open + chat.open; unknown ids are ignored).
   */
  open(inputPath: string, options: { file?: string; chatId?: string | undefined } = {}): Promise<OpenResult> {
    return this.serialize(() => this.openNow(inputPath, options));
  }

  /**
   * §20: creates <parentDir>/<name> from a template (files, scanned map, optional
   * git init + initial commit, system, `gh repo create` only when asked), remembers
   * the parent folder, then opens it. See src/projects/create.ts.
   */
  create(body: CreateProjectBody): Promise<OpenResult> {
    return this.serialize(async () => {
      const created = await createProjectFolder(
        {
          parentDir: body.parentDir,
          name: body.name,
          template: body.template,
          git: body.git,
          commit: body.commit,
          github: body.github,
          system: body.system,
          createParent: body.createParent,
        },
        // A relative location is taken from home, never from the daemon's own cwd.
        { ...this.deps.create, version: this.deps.version, cwd: this.home() },
      );
      try {
        this.deps.newProjectParent?.set(path.dirname(created.path));
      } catch {
        // remembering the folder is a convenience
      }
      const opened = await this.openNow(created.path, {});
      this.deps.overview?.invalidate();
      return { ...opened, created };
    });
  }

  /** §20 GET /api/projects/new: templates, the proposed folder, whether git can commit. */
  async newProjectDefaults(): Promise<NewProjectDefaults> {
    const home = this.home();
    const parent = suggestParentDir({
      remembered: this.deps.newProjectParent?.get(),
      recentRoots: this.deps.projects.list().map((p) => p.root),
      home,
    });
    return {
      parentDir: parent.dir,
      parentSource: parent.source,
      home,
      templates: templateInfos(),
      git: await gitToolStatus(this.deps.create ?? {}),
    };
  }

  /** §20 POST /api/projects/new/check. */
  checkNewProject(body: { parentDir: string; name: string }): NewProjectCheck {
    const home = this.home();
    return checkNewProject(body, { home, cwd: home });
  }

  /** The daemon's home: `~/…` and relative wizard locations are taken from it. */
  private home(): string {
    return this.deps.create?.home ?? process.env.HOME ?? homedir();
  }

  /** §20 GET /api/projects/new/github: gh installed + logged in (cached a minute). */
  githubStatus(): Promise<NonNullable<ToolStatus["gh"]>> {
    const now = Date.now();
    if (this.ghStatus === undefined || now - this.ghStatus.at > GH_STATUS_TTL_MS) {
      this.ghStatus = { at: now, value: ghToolStatus(this.deps.create ?? {}) };
    }
    return this.ghStatus.value;
  }

  pin(id: string, pinned: boolean): boolean {
    const ok = this.deps.projects.pin(id, pinned);
    if (ok) this.listChanged();
    return ok;
  }

  /** §20: the pinned order (ids first; see ProjectsStore.reorder). */
  reorder(ids: readonly string[]): ProjectsList {
    this.deps.projects.reorder(ids);
    this.listChanged();
    return this.list();
  }

  /** §20: a project's tags; undefined = unknown id. */
  setTags(id: string, tags: readonly string[]): ProjectInfo | undefined {
    const info = this.deps.projects.setTags(id, tags);
    if (info !== undefined) this.listChanged();
    return info;
  }

  /** §20.5: every recent project at a glance (503 without the overview service). */
  overview(limit?: number): Promise<ProjectsOverview> {
    if (this.deps.overview === undefined) return Promise.reject(new ProjectError(503, "the overview is not available"));
    return this.deps.overview.overview(limit);
  }

  private listChanged(): void {
    this.deps.overview?.invalidate();
    try {
      this.deps.onListChanged?.(this.list().recent);
    } catch {
      // a broken listener must not fail the change
    }
  }

  forget(id: string): boolean {
    const ok = this.deps.projects.forget(id);
    if (ok) this.listChanged();
    return ok;
  }

  /** `id`, else the open project's id (409 when none is open). */
  projectIdOrCurrent(id: string | undefined): string {
    const resolved = id ?? this.deps.host.project()?.id;
    if (resolved === undefined) throw new ProjectError(409, "no project is open");
    return resolved;
  }

  /** CONTRACTS §11: the project's scan options (defaults: infra on). Unknown ids get the defaults. */
  scanOptions(projectId: string): ProjectScanOptions {
    return this.deps.chats.state.scanOptions(projectId);
  }

  /** Persists scan options for a known project (the next rescan uses them). */
  setScanOptions(projectId: string, patch: Partial<ProjectScanOptions>): ProjectScanOptions {
    if (!isProjectId(projectId) || this.deps.projects.lookup(projectId) === undefined) throw new ProjectError(404, `unknown project: ${projectId}`);
    return this.deps.chats.state.setScanOptions(projectId, patch);
  }

  /** Chats of every project (or of `projectId` only), newest first, with the project's name and root. */
  recentChats(limit: number, projectId?: string): RecentChat[] {
    const out: RecentChat[] = [];
    if (projectId !== undefined && !isProjectId(projectId)) return out;
    const source = projectId !== undefined ? this.deps.chats.recentIn(projectId, limit) : this.deps.chats.recent(Number.MAX_SAFE_INTEGER);
    for (const chat of source) {
      if (out.length >= limit) break;
      const project = this.deps.projects.lookup(chat.projectId);
      if (project === undefined) continue;
      out.push({ ...toChatInfo(chat), projectName: project.name, projectRoot: project.root });
    }
    return out;
  }

  /** A stored chat's turns (any project; hover prefetch). Undefined = unknown project or chat. */
  chatHistory(projectId: string, chatId: string): TurnRecord[] | undefined {
    if (!isProjectId(projectId) || this.deps.chats.get(projectId, chatId) === undefined) return undefined;
    return this.deps.chats.history(projectId, chatId);
  }

  /** Everything to paint a project before (or while) switching to it. Undefined = unknown id. */
  preview(id: string): ProjectPreview | undefined {
    if (!isProjectId(id)) return undefined;
    const current = this.deps.host.project();
    const isCurrent = current !== null && current.id === id;
    const info: ProjectInfo | undefined = isCurrent ? current : (this.deps.projects.get(id) ?? this.lookupInfo(id));
    if (info === undefined) return undefined;
    let architecture: Architecture | null = null;
    if (isCurrent) architecture = this.deps.host.store?.current() ?? null;
    else if (info.kind === "repo") architecture = readArchitecture(path.join(info.root, ARCHITECTURE_FILE));
    const chats = this.deps.chats.list(id);
    const persisted = this.deps.chats.activeChat(id);
    const activeChatId = persisted !== undefined ? persisted : (chats[0]?.id ?? null);
    const activeTurns = activeChatId !== null ? this.deps.chats.history(id, activeChatId) : [];
    return { project: info, architecture, chats, activeChatId, activeTurns };
  }

  // ----- internals -----

  private lookupInfo(id: string): ProjectInfo | undefined {
    const identity = this.deps.projects.lookup(id);
    if (identity === undefined) return undefined;
    return { id: identity.id, name: identity.name, root: identity.root, kind: identity.kind, lastOpenedAt: new Date(0).toISOString() };
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  private async openNow(inputPath: string, options: { file?: string; chatId?: string | undefined }): Promise<OpenResult> {
    const started = performance.now();
    const trimmed = inputPath.trim();
    if (trimmed.length === 0) throw new ProjectError(400, "path is empty");
    const requested = path.resolve(expandHome(trimmed));
    let root: string;
    try {
      root = fs.realpathSync(requested);
    } catch {
      throw new ProjectError(404, `folder not found: ${requested}`);
    }
    if (!isDirectory(root)) throw new ProjectError(400, `not a folder: ${requested}`);
    const id = projectIdFor(root);

    const current = this.deps.host.project();
    const chatId = options.chatId !== undefined && this.deps.chats.get(id, options.chatId) !== undefined ? options.chatId : undefined;
    if (current !== null && current.id === id && options.file === undefined) {
      // Already open: only the recent list changes (and the requested chat opens).
      const project = this.deps.projects.touch({ id, name: current.name, root, kind: current.kind });
      if (chatId !== undefined) this.deps.host.openChat?.(chatId);
      return { project, ms: Math.round(performance.now() - started), scanned: false };
    }
    // The hub opens the project on its persisted active chat (§5.5): point it at the requested one.
    if (chatId !== undefined) this.deps.chats.setActiveChat(id, chatId);

    let store: ArchitectureStore;
    let kind: ProjectInfo["kind"] = "repo";
    let name: string | undefined;
    let scanned = false;
    let loadError: string | undefined;
    if (options.file === undefined && fs.existsSync(path.join(root, SYSTEM_FILE))) {
      kind = "system";
      const system = await (this.deps.openSystemProject ?? openSystemProjectNotWired)(root);
      store = system.store;
      name = system.name;
    } else {
      const archPath = options.file !== undefined ? path.resolve(options.file) : path.join(root, ARCHITECTURE_FILE);
      if (!fs.existsSync(archPath)) {
        this.scanInto(root, archPath, this.scanOptions(id));
        scanned = true;
      }
      store = createArchitectureStore(archPath, { watch: this.deps.watch !== false });
      const off = store.onError((error) => {
        loadError = error.message;
      });
      await store.load();
      off();
    }
    name ??= store.current()?.name ?? path.basename(root);
    const project = this.deps.projects.touch({ id, name, root, kind });
    this.deps.host.setProject({ info: project, store, loadError });
    const ms = Math.round(performance.now() - started);
    this.deps.info?.(`opened ${kind} ${name} (${root}) in ${ms} ms${scanned ? " (scanned)" : ""}`);
    return { project, ms, scanned };
  }

  /** First open of a repo: `ruah app scan` in-process, written atomically. */
  private scanInto(root: string, archPath: string, options: ProjectScanOptions): void {
    let arch: Architecture;
    try {
      arch = scanRepo(root, { version: this.deps.version, now: new Date(), infra: options.infra });
    } catch (err) {
      throw new ProjectError(500, `scan failed: ${(err as Error).message}`);
    }
    const result = validateArchitecture(arch, root);
    if (!result.ok) throw new ProjectError(422, `scan result failed validation: ${result.errors[0] ?? "unknown"}`);
    atomicWriteFileSync(archPath, `${JSON.stringify(arch, null, 2)}\n`);
  }
}
