// src/integrations/scope/file.ts — `<repo>/.ruah/cloud.json` (CONTRACTS.md §14):
// which provider accounts belong to the project and which resources the user
// added or removed by hand. Committable: no secrets, sorted, stable 2-space
// JSON with a trailing newline. Read on every scope evaluation; written only
// by an explicit user action (API / CLI), never on a read or a sync. An
// invalid file is reported, treated as empty and never overwritten.
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ScopeFileSchema,
  type ScopeAccount,
  type ScopeFile,
  type ScopeResourceRef,
} from "../../contracts/integrations.js";

export const SCOPE_FILE = path.join(".ruah", "cloud.json");
const MAX_FILE_BYTES = 1024 * 1024;

export interface ResourceRef {
  id: string;
  provider?: string;
  name?: string;
}

/** The file after normalization: refs as objects, lists always present. */
export interface ScopeConfig {
  name?: string;
  accounts: ScopeAccount[];
  include: ResourceRef[];
  exclude: ResourceRef[];
}

export interface ScopeFileRead {
  path: string;
  exists: boolean;
  /** Parse / validation problem; `config` is then empty. */
  error?: string;
  config: ScopeConfig;
}

export class ScopeFileError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

export function scopeFileOf(root: string): string {
  return path.join(root, SCOPE_FILE);
}

export function emptyScopeConfig(): ScopeConfig {
  return { accounts: [], include: [], exclude: [] };
}

function refOf(ref: ScopeResourceRef): ResourceRef {
  if (typeof ref === "string") return { id: ref };
  const out: ResourceRef = { id: ref.id };
  if (ref.provider !== undefined && ref.provider !== "") out.provider = ref.provider;
  if (ref.name !== undefined && ref.name !== "") out.name = ref.name;
  return out;
}

/** Validates parsed JSON; throws a readable message on failure. */
export function parseScopeFile(json: unknown): ScopeConfig {
  const parsed = ScopeFileSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(issue !== undefined ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "invalid file");
  }
  const data: ScopeFile = parsed.data;
  const config: ScopeConfig = {
    accounts: (data.accounts ?? []).map((a) => ({ ...a })),
    include: (data.include ?? []).map(refOf),
    exclude: (data.exclude ?? []).map(refOf),
  };
  if (data.name !== undefined) config.name = data.name;
  return normalizeConfig(config);
}

/** Reads `<root>/.ruah/cloud.json`; missing = empty, invalid = empty + error. Never throws. */
export function readScopeFile(root: string): ScopeFileRead {
  const file = scopeFileOf(root);
  let text: string;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { path: file, exists: true, error: "not a file", config: emptyScopeConfig() };
    if (st.size > MAX_FILE_BYTES) return { path: file, exists: true, error: "file larger than 1 MiB", config: emptyScopeConfig() };
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR") {
      return { path: file, exists: false, config: emptyScopeConfig() };
    }
    return { path: file, exists: true, error: `unreadable: ${(err as Error).message}`, config: emptyScopeConfig() };
  }
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    return { path: file, exists: true, error: "not valid JSON", config: emptyScopeConfig() };
  }
  try {
    return { path: file, exists: true, config: parseScopeFile(json) };
  } catch (err) {
    return { path: file, exists: true, error: (err as Error).message, config: emptyScopeConfig() };
  }
}

const accountKey = (a: ScopeAccount): string => `${a.provider}\u0000${a.account ?? ""}`;

function compareRefs(a: ResourceRef, b: ResourceRef): number {
  return (a.provider ?? "").localeCompare(b.provider ?? "", "en") || (a.name ?? "").localeCompare(b.name ?? "", "en") || a.id.localeCompare(b.id, "en");
}

/** De-duplicated and sorted; a resource is never both included and excluded (exclude wins). */
export function normalizeConfig(config: ScopeConfig): ScopeConfig {
  const accounts = new Map<string, ScopeAccount>();
  for (const a of config.accounts) {
    const entry: ScopeAccount = { provider: a.provider };
    if (a.account !== undefined) entry.account = a.account;
    if (a.whole === true) entry.whole = true;
    const prev = accounts.get(accountKey(entry));
    accounts.set(accountKey(entry), prev?.whole === true ? { ...entry, whole: true } : entry);
  }
  const uniq = (refs: readonly ResourceRef[]): ResourceRef[] => {
    const byId = new Map<string, ResourceRef>();
    for (const r of refs) byId.set(r.id, { ...byId.get(r.id), ...r });
    return [...byId.values()].sort(compareRefs);
  };
  const exclude = uniq(config.exclude);
  const excluded = new Set(exclude.map((r) => r.id));
  const out: ScopeConfig = {
    accounts: [...accounts.values()].sort((a, b) => a.provider.localeCompare(b.provider, "en") || (a.account ?? "").localeCompare(b.account ?? "", "en")),
    include: uniq(config.include).filter((r) => !excluded.has(r.id)),
    exclude,
  };
  if (config.name !== undefined) out.name = config.name;
  return out;
}

/** Stable 2-space JSON with a trailing newline; empty lists are left out. */
export function formatScopeFile(config: ScopeConfig): string {
  const c = normalizeConfig(config);
  const file: Record<string, unknown> = { version: 1 };
  if (c.name !== undefined) file.name = c.name;
  if (c.accounts.length > 0) file.accounts = c.accounts.map((a) => ({ provider: a.provider, ...(a.account !== undefined ? { account: a.account } : {}), ...(a.whole === true ? { whole: true } : {}) }));
  const refs = (list: ResourceRef[]): unknown[] => list.map((r) => ({ id: r.id, ...(r.provider !== undefined ? { provider: r.provider } : {}), ...(r.name !== undefined ? { name: r.name } : {}) }));
  if (c.include.length > 0) file.include = refs(c.include);
  if (c.exclude.length > 0) file.exclude = refs(c.exclude);
  return `${JSON.stringify(file, null, 2)}\n`;
}

function atomicWrite(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/**
 * Read-modify-write of `<root>/.ruah/cloud.json` for an explicit user action.
 * Refuses (409) while the file is invalid so a hand edit is never lost; writes
 * only when the formatted content changes. Returns the new config.
 */
export function updateScopeFile(root: string, mutate: (config: ScopeConfig) => ScopeConfig): ScopeConfig {
  const current = readScopeFile(root);
  if (current.error !== undefined) {
    throw new ScopeFileError(`${current.path} is invalid (${current.error}) — fix or delete it first; Ruah will not overwrite it`);
  }
  const next = normalizeConfig(mutate(structuredClone(current.config)));
  const text = formatScopeFile(next);
  const before = current.exists ? formatScopeFile(current.config) : null;
  if (text !== before) {
    // An untouched project (nothing to say) keeps no file.
    if (!current.exists && text === formatScopeFile(emptyScopeConfig())) return next;
    atomicWrite(current.path, text);
  }
  return next;
}

/** include / exclude / reset one resource in a config (pure). */
export function applyResourceAction(config: ScopeConfig, ref: ResourceRef, action: "include" | "exclude" | "reset"): ScopeConfig {
  const include = config.include.filter((r) => r.id !== ref.id);
  const exclude = config.exclude.filter((r) => r.id !== ref.id);
  if (action === "include") include.push(ref);
  if (action === "exclude") exclude.push(ref);
  return { ...config, include, exclude };
}
