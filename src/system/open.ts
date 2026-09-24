// src/system/open.ts — opening a folder that holds ruah.system.json as a
// project (CONTRACTS §5.3 "open", docs/MULTI-REPO.md): rebuild the system
// architecture (keeping hand edits), write it next to the system file, and
// return a store whose paths ("<repoId>/<rel>") resolve into each repo.
//
// Every open system gets a SystemHandle (CONTRACTS §12): the daemon's
// /api/system/* endpoints change ruah.system.json through src/system/manage.ts
// and call handle.reload(), which re-reads the file, re-registers the repo
// roots, rebuilds the map and saves it through the store (broadcast as
// `architecture` reason "saved") — the project stays open, no switch.
import * as path from "node:path";
import { createArchitectureStore, type ArchitectureStore } from "../serve/architecture-store.js";
import { ProjectError, type OpenSystemProject } from "../projects/service.js";
import type { SystemBuildResult } from "./build.js";
import { loadSystem, resolveSystemPath, type LoadedSystem } from "./config.js";
import { rebuildSystem, rescanRepo, SystemManageError } from "./manage.js";
import { registerSystemRoots } from "./roots.js";

export interface SystemHandle {
  readonly dir: string;
  readonly store: ArchitectureStore;
  /** ruah.system.json as last loaded. */
  system(): LoadedSystem;
  /**
   * Re-reads ruah.system.json and rebuilds the system map (hand edits merged
   * from the map on disk); `rescan` first re-scans that repo. Saved through
   * the store. Calls are serialized.
   */
  reload(opts?: { rescan?: string }): Promise<SystemBuildResult>;
  version: string;
}

const handles = new Map<string, SystemHandle>();

/** The handle of the system open at `root` (the folder holding ruah.system.json). */
export function systemHandleFor(root: string): SystemHandle | undefined {
  return handles.get(root);
}

export function makeOpenSystemProject(version: string, options: { watch?: boolean } = {}): OpenSystemProject {
  return async (root) => {
    let sys: LoadedSystem;
    try {
      sys = loadSystem(root);
    } catch (err) {
      throw new ProjectError(422, `invalid ruah.system.json: ${(err as Error).message}`);
    }
    try {
      rebuildSystem(sys, { version });
    } catch (err) {
      throw new ProjectError(422, (err as Error).message);
    }
    const out = path.join(sys.dir, "architecture.json");
    registerSystemRoots(sys.dir, sys.repos.map((r) => r.root), sys.repos.map((r) => r.id));
    const store = createArchitectureStore(out, {
      watch: options.watch ?? true,
      // Reads the handle's current system, so repos added later resolve too.
      resolvePath: (rel) => {
        const hit = resolveSystemPath(sys, rel);
        return hit === null ? null : { abs: hit.abs, root: hit.root };
      },
    });
    await store.load();
    let queue: Promise<unknown> = Promise.resolve();
    const handle: SystemHandle = {
      dir: sys.dir,
      store,
      version,
      system: () => sys,
      reload: (opts = {}) => {
        const run = async (): Promise<SystemBuildResult> => {
          let next: LoadedSystem;
          try {
            next = loadSystem(sys.dir);
          } catch (err) {
            throw new SystemManageError("invalid", `invalid ruah.system.json: ${(err as Error).message}`);
          }
          const result =
            opts.rescan !== undefined
              ? rescanRepo(next.file, opts.rescan, { version, write: false })
              : rebuildSystem(next, { version, write: false });
          sys = next;
          registerSystemRoots(sys.dir, sys.repos.map((r) => r.root), sys.repos.map((r) => r.id));
          await store.save(result.architecture, { by: { kind: "scan" } });
          return result;
        };
        const p = queue.then(run, run);
        queue = p.catch(() => {});
        return p;
      },
    };
    handles.set(sys.dir, handle);
    const close = store.close.bind(store);
    store.close = () => {
      if (handles.get(sys.dir) === handle) handles.delete(sys.dir);
      close();
    };
    return { store, name: sys.name };
  };
}
