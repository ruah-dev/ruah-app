// src/system/roots.ts — the repo roots of each open multi-repo system, keyed by
// the system folder. The agent catalog reads it so a Claude session started in
// a system gets every repo as an additional working directory; the context
// pack reads the per-repo roots to tell the agent where an element's repo is.
const roots = new Map<string, readonly string[]>();
const repoRoots = new Map<string, ReadonlyMap<string, string>>();

export function registerSystemRoots(systemRoot: string, repoRootList: readonly string[], repoIds?: readonly string[]): void {
  roots.set(systemRoot, [...repoRootList]);
  if (repoIds !== undefined) repoRoots.set(systemRoot, new Map(repoIds.map((id, i) => [id, repoRootList[i] ?? ""])));
}

export function systemRootsFor(root: string): string[] {
  return [...(roots.get(root) ?? [])];
}

/** The folder of repo `repoId` of the system open at `systemRoot`, when registered. */
export function systemRepoRoot(systemRoot: string, repoId: string): string | undefined {
  const hit = repoRoots.get(systemRoot)?.get(repoId);
  return hit === undefined || hit === "" ? undefined : hit;
}
