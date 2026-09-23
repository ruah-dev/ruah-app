// src/integrations/store.ts — the three files integrations persist:
//   ~/.ruah/integrations.json                     non-secret selections (doctl context, AWS profile/regions, Jira site+email)
//   ~/.ruah/projects/<projectId>/cloud.json       last cloud sync + manual resource→element links
//   <projectRoot>/.ruah/links.json                element ↔ work item links (committable, sorted, stable)
// No secret ever lands in any of them (tokens live in the Keychain / the CLIs).
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CloudCacheSchema,
  LinksFileSchema,
  type CloudCache,
  type LinksFile,
  type WorkLink,
} from "../contracts/integrations.js";
import { projectIdFor } from "../projects/fs-util.js";

/** CONTRACTS.md §5.1: sha1(realpath(root)).slice(0, 12). */
export function projectIdOf(root: string): string {
  let real = path.resolve(root);
  try {
    real = fs.realpathSync(real);
  } catch {
    // a missing directory still gets a stable id from its resolved path
  }
  return projectIdFor(real);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function atomicWrite(file: string, data: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data, mode !== undefined ? { mode } : {});
  fs.renameSync(tmp, file);
}

// ---- settings -----------------------------------------------------------------

export interface ProviderSettings {
  /** doctl context / AWS profile / GitHub host. */
  account?: string;
  /** AWS regions to sync. */
  regions?: string[];
  /** Jira site base URL and login e-mail (the token is in the Keychain). */
  site?: string;
  email?: string;
  /** "Disconnected in Ruah": status not_connected, skipped by sync; the CLI login is untouched. */
  disabled?: boolean;
}

export class SettingsStore {
  readonly file: string;
  constructor(home: string) {
    this.file = path.join(home, "integrations.json");
  }

  all(): Record<string, ProviderSettings> {
    const raw = readJson(this.file) as { providers?: unknown } | undefined;
    const providers = raw?.providers;
    if (typeof providers !== "object" || providers === null) return {};
    return providers as Record<string, ProviderSettings>;
  }

  get(id: string): ProviderSettings {
    return this.all()[id] ?? {};
  }

  set(id: string, value: ProviderSettings | undefined): void {
    const providers = this.all();
    if (value === undefined || Object.keys(value).length === 0) delete providers[id];
    else providers[id] = value;
    atomicWrite(this.file, `${JSON.stringify({ version: 1, providers }, null, 2)}\n`, 0o600);
  }
}

// ---- cloud cache -----------------------------------------------------------------

export function emptyCloudCache(): CloudCache {
  return { version: 1, syncedAt: null, resources: [], errors: [], manualLinks: {} };
}

export class CloudCacheStore {
  constructor(private readonly home: string) {}

  fileFor(projectRoot: string): string {
    return path.join(this.home, "projects", projectIdOf(projectRoot), "cloud.json");
  }

  read(projectRoot: string): CloudCache {
    const parsed = CloudCacheSchema.safeParse(readJson(this.fileFor(projectRoot)));
    return parsed.success ? (parsed.data as CloudCache) : emptyCloudCache();
  }

  write(projectRoot: string, cache: CloudCache): void {
    atomicWrite(this.fileFor(projectRoot), `${JSON.stringify(cache, null, 2)}\n`, 0o600);
  }
}

// ---- links.json --------------------------------------------------------------------

export function linksFileOf(projectRoot: string): string {
  return path.join(projectRoot, ".ruah", "links.json");
}

function compareLinks(a: WorkLink, b: WorkLink): number {
  return a.nodeId.localeCompare(b.nodeId, "en") || a.provider.localeCompare(b.provider, "en") || a.itemId.localeCompare(b.itemId, "en", { numeric: true });
}

/** Sorted, de-duplicated, stable 2-space JSON with a trailing newline (diffs stay minimal). */
export function formatLinks(links: readonly WorkLink[]): string {
  const seen = new Set<string>();
  const unique: WorkLink[] = [];
  for (const l of links) {
    const key = `${l.nodeId}\u0000${l.provider}\u0000${l.itemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ nodeId: l.nodeId, provider: l.provider, itemId: l.itemId });
  }
  unique.sort(compareLinks);
  const file: LinksFile = { version: 1, links: unique };
  return `${JSON.stringify(file, null, 2)}\n`;
}

export function readLinks(projectRoot: string): WorkLink[] {
  const parsed = LinksFileSchema.safeParse(readJson(linksFileOf(projectRoot)));
  return parsed.success ? parsed.data.links : [];
}

/** Adds or removes one link; returns the new list. Writes only when something changed. */
export function updateLink(projectRoot: string, link: WorkLink, linked: boolean): WorkLink[] {
  const current = readLinks(projectRoot);
  const same = (l: WorkLink): boolean => l.nodeId === link.nodeId && l.provider === link.provider && l.itemId === link.itemId;
  const exists = current.some(same);
  if (exists === linked) return current;
  const next = linked ? [...current, link] : current.filter((l) => !same(l));
  atomicWrite(linksFileOf(projectRoot), formatLinks(next));
  return readLinks(projectRoot);
}
