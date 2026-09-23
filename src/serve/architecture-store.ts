import * as fs from "node:fs";
import * as path from "node:path";
import type { Architecture } from "../contracts/architecture.js";
import { validateArchitecture } from "../contracts/validate.js";
import { layout } from "./layout.js";
import type { MapActor, MapChange } from "../contracts/map.js";

export type StoreChangeReason = "initial" | "changed" | "saved";

export interface StoreEvent {
  reason: StoreChangeReason;
  revision: number;
  architecture: Architecture;
  /** Who saved it (reason "saved"; CONTRACTS §1.7). */
  by?: MapActor;
  /** Element-level summary of an agent op / undo. */
  changes?: MapChange[];
}

/** Optional provenance of a save, carried on the change event (and the WS broadcast). */
export interface SaveMeta {
  by?: MapActor;
  changes?: MapChange[];
}

export interface StoreError {
  path: string;
  message: string;
}

export interface ArchitectureStore {
  readonly path: string; // absolute architecture.json path
  readonly root: string; // absolute repo dir
  readonly revision: number;
  current(): Architecture | null;
  load(): Promise<void>; // read + validate + layout + notify(reason "initial"/"changed")
  save(architecture: Architecture, meta?: SaveMeta): Promise<void>; // validate + atomic write + notify(reason "saved")
  close(): void;
  /**
   * Multi-repo systems: maps a system path ("<repoId>/<rel>") to the real file
   * and the repo root it must stay inside. Absent for single repos (paths are
   * relative to `root`).
   */
  resolvePath?(rel: string): { abs: string; root: string } | null;
  onChange(listener: (event: StoreEvent) => void): () => void;
  onError(listener: (error: StoreError) => void): () => void;
}

const WATCH_DEBOUNCE_MS = 250;

function readValidated(
  archPath: string,
  root: string,
  skipIfEquals?: string,
): { architecture: Architecture } | { error: string } | { unchanged: true } {
  let raw: string;
  try {
    raw = fs.readFileSync(archPath, "utf8");
  } catch (err) {
    return { error: `cannot read ${archPath}: ${(err as Error).message}` };
  }
  if (skipIfEquals !== undefined && raw === skipIfEquals) return { unchanged: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { error: `invalid JSON in ${archPath}: ${(err as Error).message}` };
  }
  const result = validateArchitecture(parsed, root);
  if (!result.ok) return { error: result.errors.join("; ") };
  return { architecture: layout(result.value) };
}

function atomicWrite(filePath: string, data: string): void {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

export interface ArchitectureStoreOptions {
  watch?: boolean;
  resolvePath?: (rel: string) => { abs: string; root: string } | null;
}

export function createArchitectureStore(archPath: string, options: ArchitectureStoreOptions = {}): ArchitectureStore {
  const archPathAbs = path.resolve(archPath);
  const root = path.dirname(archPathAbs);
  const watchers = new Set<(event: StoreEvent) => void>();
  const errorListeners = new Set<(error: StoreError) => void>();
  let revision = 0;
  let current: Architecture | null = null;
  let watcher: fs.FSWatcher | undefined;
  let debounce: NodeJS.Timeout | undefined;
  let closed = false;
  let initial = true;
  /** Content of our own last write: the watcher's echo of it is not a change. */
  let lastWritten: string | undefined;

  function emitError(message: string): void {
    for (const listener of errorListeners) listener({ path: archPathAbs, message });
  }

  function apply(architecture: Architecture, reason: StoreChangeReason, meta: SaveMeta = {}): void {
    current = architecture;
    revision += 1;
    const event: StoreEvent = {
      reason,
      revision,
      architecture,
      ...(meta.by !== undefined ? { by: meta.by } : {}),
      ...(meta.changes !== undefined ? { changes: meta.changes } : {}),
    };
    for (const listener of watchers) listener(event);
  }

  function reload(reason: StoreChangeReason): void {
    const res = readValidated(archPathAbs, root, initial ? undefined : lastWritten);
    if ("unchanged" in res) return;
    lastWritten = undefined;
    if ("error" in res) {
      // Invalid file: keep the last good revision, emit architecture.error.
      emitError(res.error);
      return;
    }
    apply(res.architecture, initial ? "initial" : reason);
    initial = false;
  }

  const store: ArchitectureStore = {
    ...(options.resolvePath !== undefined ? { resolvePath: options.resolvePath } : {}),
    path: archPathAbs,
    root,
    get revision() {
      return revision;
    },
    current: () => current,
    load: () =>
      new Promise<void>((resolveLoad) => {
        reload("changed");
        resolveLoad();
      }),
    save: (architecture, meta) =>
      new Promise<void>((resolveSave, reject) => {
        const result = validateArchitecture(architecture, root);
        if (!result.ok) {
          reject(new Error(result.errors.join("; ")));
          return;
        }
        const text = `${JSON.stringify(architecture, null, 2)}\n`;
        try {
          atomicWrite(archPathAbs, text);
        } catch (err) {
          reject(err as Error);
          return;
        }
        lastWritten = text;
        apply(layout(result.value), "saved", meta);
        resolveSave();
      }),
    close: () => {
      watcher?.close();
      if (debounce !== undefined) clearTimeout(debounce);
    },
    onChange: (listener) => {
      watchers.add(listener);
      return () => watchers.delete(listener);
    },
    onError: (listener) => {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
  };

  if (options.watch !== false) {
    try {
      watcher = fs.watch(path.dirname(archPathAbs), (eventType, filename) => {
        if (filename !== null && path.basename(archPathAbs) !== filename) return;
        if (debounce !== undefined) clearTimeout(debounce);
        debounce = setTimeout(() => {
          debounce = undefined;
          reload("changed");
        }, 250);
      });
    } catch {
      // Watch failures are non-fatal; the file can still be re-served on demand.
    }
  }

  return store;
}
