// src/extensions/store.ts — the three files the extensions library keeps:
//   $RUAH_HOME/extensions.json            global extensions (this machine)
//   <repo>/.ruah/extensions.json          project extensions (committable, sorted, no secrets,
//                                         local sources inside the repo stored relative)
//   $RUAH_HOME/extensions-trust.json      approvals: the fingerprint of what each extension ran
//                                         when the user enabled it (§17.4). A project file from
//                                         someone else's commit is not injected until approved here.
//   $RUAH_HOME/extensions-installs.json   "Also install into" records of this machine (what Remove
//                                         undoes), keyed like approvals. Never read from a project
//                                         file: a commit must not be able to make Remove delete things.
// A file that cannot be read (bad JSON, schema error, > 1 MiB) is reported and never overwritten.
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ExtensionsFileSchema,
  InstallRecordSchema,
  type Extension,
  type ExtensionScope,
  type ExtensionSource,
  type InstallRecord,
} from "../contracts/extensions.js";
import { atomicWriteFileSync } from "../projects/fs-util.js";
import { ensureRuahGitignore } from "../projects/repo-files.js";
import { ExtensionError, slugify } from "./model.js";

const MAX_FILE_BYTES = 1024 * 1024;

export interface ReadResult {
  file: string;
  extensions: Extension[];
  /** Set when the file exists but cannot be used; writes are refused until it is fixed. */
  error?: string;
}

function readFile(file: string): ReadResult {
  let text: string;
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_FILE_BYTES) return { file, extensions: [], error: "file is larger than 1 MiB" };
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { file, extensions: [] };
    return { file, extensions: [], error: `cannot read: ${(err as Error).message}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { file, extensions: [], error: "not valid JSON" };
  }
  const parsed = ExtensionsFileSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { file, extensions: [], error: `invalid: ${issue !== undefined ? `${issue.path.join(".") || "file"}: ${issue.message}` : "schema error"}` };
  }
  // Duplicate ids: the first wins (a hand edit must not make two entries share a Keychain account).
  const seen = new Set<string>();
  const extensions = parsed.data.extensions.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
  return { file, extensions };
}

function serialize(extensions: Extension[]): string {
  const sorted = [...extensions].sort((a, b) => a.id.localeCompare(b.id));
  return `${JSON.stringify({ version: 1, extensions: sorted }, null, 2)}\n`;
}

export interface TrustFile {
  version: 1;
  /** `<scopeKey>/<id>` → fingerprint approved by the user. */
  approved: Record<string, string>;
}

const InstallsFileSchema = z.object({
  version: z.literal(1),
  installs: z.record(z.string(), z.array(z.unknown())),
});

function realOrResolved(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export class ExtensionsStore {
  readonly globalFile: string;
  readonly trustFile: string;
  readonly installsFile: string;
  /** Git clones live here (one folder per URL + ref). */
  readonly sourcesDir: string;
  /** Generated per-session plugin folders (skills bundle for Claude / Cursor / Grok / OpenCode). */
  readonly runtimeDir: string;

  constructor(readonly home: string) {
    this.globalFile = path.join(home, "extensions.json");
    this.trustFile = path.join(home, "extensions-trust.json");
    this.installsFile = path.join(home, "extensions-installs.json");
    this.sourcesDir = path.join(home, "extensions", "src");
    this.runtimeDir = path.join(home, "extensions", "runtime");
  }

  projectFile(root: string): string {
    return path.join(root, ".ruah", "extensions.json");
  }

  /**
   * False when `root/.ruah` is Ruah's own home (e.g. $HOME with the default
   * RUAH_HOME ~/.ruah): its extensions.json is the global file, not a project's.
   */
  isProjectRoot(root: string): boolean {
    return realOrResolved(path.join(root, ".ruah")) !== realOrResolved(this.home) && realOrResolved(this.projectFile(root)) !== realOrResolved(this.globalFile);
  }

  fileFor(scope: ExtensionScope, root: string | undefined): string {
    if (scope === "global") return this.globalFile;
    if (root === undefined) throw new ExtensionError(409, "no project is open");
    if (!this.isProjectRoot(root)) throw new ExtensionError(409, `${root} is not a project: its .ruah folder is Ruah's home (global extensions); open a repository or pass --repo`);
    return this.projectFile(root);
  }

  read(scope: ExtensionScope, root?: string): ReadResult {
    return readFile(this.fileFor(scope, root));
  }

  /** Applies `change` to the list and writes it when the content changed. Refuses an unreadable file. */
  update(scope: ExtensionScope, root: string | undefined, change: (list: Extension[]) => Extension[]): Extension[] {
    const current = this.read(scope, root);
    if (current.error !== undefined) throw new ExtensionError(409, `${current.file}: ${current.error} — fix or delete it first`);
    const next = change(current.extensions.map((e) => ({ ...e })));
    const before = serialize(current.extensions);
    const after = serialize(next);
    if (before !== after) {
      if (next.length === 0 && scope === "project" && !fs.existsSync(current.file)) return next;
      atomicWriteFileSync(current.file, after);
      if (scope === "global") fs.chmodSync(current.file, 0o600);
      else if (root !== undefined) ensureRuahGitignore(root);
    }
    return next;
  }

  get(scope: ExtensionScope, root: string | undefined, id: string): Extension | undefined {
    return this.read(scope, root).extensions.find((e) => e.id === id);
  }

  // ---- sources ------------------------------------------------------------------

  /** The clone folder of a git source (deterministic from URL + ref). */
  cloneDir(url: string, ref: string | undefined): string {
    const hash = createHash("sha1").update(`${url}#${ref ?? ""}`).digest("hex").slice(0, 8);
    const base = slugify(url.replace(/^.*[/:]/, "")) || "repo";
    return path.join(this.sourcesDir, `${base}-${hash}`);
  }

  /** Absolute path of an extension's folder or file; undefined for inline / featured MCP servers. */
  resolvePath(source: ExtensionSource, scope: ExtensionScope, root: string | undefined): string | undefined {
    switch (source.type) {
      case "local":
        if (path.isAbsolute(source.path)) return source.path;
        if (scope === "project" && root !== undefined) return path.resolve(root, source.path);
        return path.resolve(source.path);
      case "git": {
        const dir = this.cloneDir(source.url, source.ref);
        return source.subdir !== undefined && source.subdir.length > 0 ? path.join(dir, source.subdir) : dir;
      }
      default:
        return undefined;
    }
  }

  /** How a local path is stored: relative to the repo root for project extensions inside the repo. */
  storedLocalPath(abs: string, scope: ExtensionScope, root: string | undefined): string {
    if (scope === "project" && root !== undefined) {
      const real = (p: string): string => {
        try {
          return fs.realpathSync(p);
        } catch {
          return p;
        }
      };
      const rel = path.relative(real(root), real(abs));
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel.length === 0 ? "." : rel.split(path.sep).join("/");
    }
    return abs;
  }

  // ---- approvals ------------------------------------------------------------------

  trust(): TrustFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.trustFile, "utf8")) as Partial<TrustFile>;
      const approved: Record<string, string> = {};
      if (raw.approved !== undefined && typeof raw.approved === "object" && raw.approved !== null) {
        for (const [key, value] of Object.entries(raw.approved)) if (typeof value === "string") approved[key] = value;
      }
      return { version: 1, approved };
    } catch {
      return { version: 1, approved: {} };
    }
  }

  approvedFingerprint(scopeKey: string, id: string): string | undefined {
    return this.trust().approved[`${scopeKey}/${id}`];
  }

  approve(scopeKey: string, id: string, fp: string): void {
    const trust = this.trust();
    if (trust.approved[`${scopeKey}/${id}`] === fp) return;
    trust.approved[`${scopeKey}/${id}`] = fp;
    this.writeTrust(trust);
  }

  revoke(scopeKey: string, id: string): void {
    const trust = this.trust();
    if (trust.approved[`${scopeKey}/${id}`] === undefined) return;
    delete trust.approved[`${scopeKey}/${id}`];
    this.writeTrust(trust);
  }

  // ---- install records ------------------------------------------------------------

  private readInstalls(): Record<string, unknown[]> {
    try {
      const parsed = InstallsFileSchema.safeParse(JSON.parse(fs.readFileSync(this.installsFile, "utf8")));
      return parsed.success ? parsed.data.installs : {};
    } catch {
      return {};
    }
  }

  /** "Also install into" records of `<scopeKey>/<id>` made on this machine (invalid entries dropped). */
  installs(scopeKey: string, id: string): InstallRecord[] {
    const raw = this.readInstalls()[`${scopeKey}/${id}`] ?? [];
    const out: InstallRecord[] = [];
    for (const item of raw) {
      const parsed = InstallRecordSchema.safeParse(item);
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }

  setInstalls(scopeKey: string, id: string, records: readonly InstallRecord[]): void {
    const all = this.readInstalls();
    const key = `${scopeKey}/${id}`;
    if (records.length === 0) {
      if (all[key] === undefined) return;
      delete all[key];
    } else all[key] = [...records].slice(-32);
    const installs = Object.fromEntries(Object.entries(all).sort(([a], [b]) => a.localeCompare(b)));
    atomicWriteFileSync(this.installsFile, `${JSON.stringify({ version: 1, installs }, null, 2)}\n`);
    fs.chmodSync(this.installsFile, 0o600);
  }

  private writeTrust(trust: TrustFile): void {
    const approved = Object.fromEntries(Object.entries(trust.approved).sort(([a], [b]) => a.localeCompare(b)));
    atomicWriteFileSync(this.trustFile, `${JSON.stringify({ version: 1, approved }, null, 2)}\n`);
    fs.chmodSync(this.trustFile, 0o600);
  }
}
