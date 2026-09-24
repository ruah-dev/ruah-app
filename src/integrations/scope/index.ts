// src/integrations/scope/index.ts — per-project cloud scope (CONTRACTS.md §14),
// a standalone library: no daemon, no network, no tokens. The daemon
// (IntegrationsService), the Cloud page (through it) and `ruah app cloud` all
// use it:
//
//   loadScopeUnits(root)      the project's folder(s) — one repo, or a system
//                             folder + its repos — with their `.ruah/cloud.json`
//                             and repo signals (bounded file reads)
//   applyScope(...)           every resource gets `scope: { in, confidence, reasons }`;
//                             auto links of out-of-scope resources are dropped
//   scopeSummary(units)       accounts + file status for the viewer
//   syncAccountPlan(units)    which accounts a project sync queries
import * as fs from "node:fs";
import * as path from "node:path";
import type { ArchNode } from "../../contracts/architecture.js";
import type { CloudResource, CloudScopeSummary, ResourceScope, ScopeAccountEntry } from "../../contracts/integrations.js";
import { loadSystem, SYSTEM_FILE } from "../../system/config.js";
import { projectIdOf } from "../store.js";
import { evaluateScope, type ScopeUnit } from "./evaluate.js";
import { readScopeFile, type ScopeFileRead } from "./file.js";
import { collectRepoSignals, type RepoSignals } from "./signals.js";

export * from "./file.js";
export { claimMatches, evaluateScope, resourceHosts, type EvaluateInput, type ScopeUnit } from "./evaluate.js";
export { collectRepoSignals, hostsInText, squash, type Claim, type Evidence, type RepoSignals } from "./signals.js";

/** A unit plus the file status (for the summary / CLI). */
export interface LoadedUnit extends ScopeUnit {
  file: ScopeFileRead;
}

export interface LoadOptions {
  /** Reuses signals collected recently (the daemon); default: always collect. */
  signals?: (root: string, extraNames: readonly string[]) => RepoSignals;
}

/**
 * The project's scope units: one for a repo; for a multi-repo system (the
 * folder holds `ruah.system.json`) the system folder first, then each repo.
 * Never throws: an unreadable system file degrades to a single unit.
 */
export function loadScopeUnits(root: string, opts: LoadOptions = {}): LoadedUnit[] {
  const abs = path.resolve(root);
  const collect = opts.signals ?? ((r: string, names: readonly string[]) => collectRepoSignals(r, { extraNames: names }));
  const unit = (r: string, extra: Partial<ScopeUnit>, names: readonly string[] = []): LoadedUnit => {
    const file = readScopeFile(r);
    return { root: r, file, config: file.config, signals: collect(r, names), ...extra };
  };
  if (fs.existsSync(path.join(abs, SYSTEM_FILE))) {
    try {
      const system = loadSystem(abs);
      return [
        unit(abs, { system: true }, [system.name]),
        ...system.repos.map((repo) => unit(repo.root, { repo: repo.id }, [repo.id])),
      ];
    } catch {
      // invalid system file: treat the folder as a plain project
    }
  }
  return [unit(abs, {})];
}

export interface ApplyScopeInput {
  units: readonly ScopeUnit[];
  resources: readonly CloudResource[];
  nodes: readonly ArchNode[];
  manualLinks?: Readonly<Record<string, string | null>>;
}

/**
 * Copies of `resources` with `scope` set. Out-of-scope resources lose an
 * automatic element link (tag / name): only the project's resources link to
 * its map (a manual link is evidence, so it stays in scope unless excluded).
 */
export function applyScope(input: ApplyScopeInput): CloudResource[] {
  const projectIds = input.units.map((u) => projectIdOf(u.root));
  const scopes = evaluateScope({ units: input.units, resources: input.resources, nodes: input.nodes, projectIds, ...(input.manualLinks !== undefined ? { manualLinks: input.manualLinks } : {}) });
  return input.resources.map((r) => {
    const scope: ResourceScope = scopes.get(r.id) ?? { in: false, reasons: [] };
    if (scope.in) return { ...r, scope };
    const { linkedNodeId: _l, linkSource: _s, ...rest } = r;
    return { ...rest, scope };
  });
}

/** Resources without their `scope` (the cache stores raw snapshots). */
export function withoutScope(resources: readonly CloudResource[]): CloudResource[] {
  return resources.map((r) => {
    if (r.scope === undefined) return r;
    const { scope: _scope, ...rest } = r;
    return rest;
  });
}

/** The unit edits go to: the system folder of a system, else the repo. */
export function ownUnit<T extends ScopeUnit>(units: readonly T[]): T | undefined {
  return units.find((u) => u.system === true) ?? units[0];
}

export function scopeSummary(units: readonly LoadedUnit[]): CloudScopeSummary {
  const accounts: ScopeAccountEntry[] = [];
  const seen = new Set<string>();
  for (const u of units) {
    for (const a of u.config.accounts) {
      const key = `${a.provider}\u0000${a.account ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      accounts.push({ ...a, ...(u.repo !== undefined ? { repo: u.repo } : {}) });
    }
  }
  const configured = units.some((u) => u.config.accounts.length + u.config.include.length + u.config.exclude.length > 0);
  const own = ownUnit(units);
  return {
    configured,
    accounts,
    files: units.map((u) => ({ ...(u.repo !== undefined ? { repo: u.repo } : {}), path: u.file.path, exists: u.file.exists, ...(u.file.error !== undefined ? { error: u.file.error } : {}) })),
    writable: own?.file.error === undefined,
  };
}

/**
 * Accounts to sync per provider for this project, or null when no scope file
 * lists any account (today's behaviour: every enabled provider, its selected
 * account). `undefined` in a list = the provider's selected / default account.
 */
export function syncAccountPlan(units: readonly ScopeUnit[]): Map<string, (string | undefined)[]> | null {
  const plan = new Map<string, (string | undefined)[]>();
  for (const u of units) {
    for (const a of u.config.accounts) {
      const list = plan.get(a.provider) ?? [];
      if (!list.includes(a.account)) list.push(a.account);
      plan.set(a.provider, list);
    }
  }
  return plan.size > 0 ? plan : null;
}

/** Short-lived cache of repo signals (the daemon re-evaluates scope on every read and push). */
export class SignalsCache {
  private readonly entries = new Map<string, { at: number; signals: RepoSignals }>();
  constructor(
    private readonly ttlMs = 15_000,
    private readonly now: () => number = Date.now,
  ) {}

  get(root: string, extraNames: readonly string[]): RepoSignals {
    const key = `${root}\u0000${extraNames.join(",")}`;
    const hit = this.entries.get(key);
    if (hit !== undefined && this.now() - hit.at < this.ttlMs) return hit.signals;
    const signals = collectRepoSignals(root, { extraNames });
    this.entries.set(key, { at: this.now(), signals });
    return signals;
  }

  clear(): void {
    this.entries.clear();
  }
}
