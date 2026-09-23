// src/system/roots.ts — the repo roots of each open multi-repo system, keyed by
// the system folder. The agent catalog reads it so a Claude session started in
// a system gets every repo as an additional working directory.
const roots = new Map<string, readonly string[]>();

export function registerSystemRoots(systemRoot: string, repoRoots: readonly string[]): void {
  roots.set(systemRoot, [...repoRoots]);
}

export function systemRootsFor(root: string): string[] {
  return [...(roots.get(root) ?? [])];
}
