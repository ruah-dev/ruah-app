import * as fs from "node:fs";
import * as path from "node:path";
import type { Architecture } from "../contracts/architecture.js";
import { validateArchitecture } from "../contracts/validate.js";
import { layout } from "./layout.js";

export type StoreChangeReason = "initial" | "changed" | "saved";

export interface StoreEvent {
  reason: StoreChangeReason;
  revision: number;
  architecture: Architecture;
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
  save(architecture: Architecture): Promise<void>; // validate + atomic write + notify(reason "saved")
  close(): void;
  onChange(listener: (event: StoreEvent) => void): () => void;
  onError(listener: (error: StoreError) => void): () => void;
}

const WATCH_DEBOUNCE_MS = 250;

function readValidated(archPath: string, root: string): { architecture: Architecture } | { error: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(archPath, "utf8");
  } catch (err) {
    return { error: `cannot read ${archPath}: ${(err as Error).message}` };
  }
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

export function createArchitectureStore(archPath: string, options: { watch?: boolean } = {}): ArchitectureStore {
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

  function emitError(message: string): void {
    for (const listener of errorListeners) listener({ path: archPathAbs, message });
  }

  function apply(architecture: Architecture, reason: StoreChangeReason): void {
    current = architecture;
    revision += 1;
    const event: StoreEvent = { reason, revision, architecture };
    for (const listener of watchers) listener(event);
  }

  function reload(reason: StoreChangeReason): void {
    const res = readValidated(archPathAbs, root);
    if ("error" in res) {
      // Invalid file: keep the last good revision, emit architecture.error.
      emitError(res.error);
      return;
    }
    apply(res.architecture, initial ? "initial" : reason);
    initial = false;
  }

  const store: ArchitectureStore = {
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
    save: (architecture) =>
      new Promise<void>((resolveSave, reject) => {
        const result = validateArchitecture(architecture, root);
        if (!result.ok) {
          reject(new Error(result.errors.join("; ")));
          return;
        }
        try {
          atomicWrite(archPathAbs, `${JSON.stringify(architecture, null, 2)}\n`);
        } catch (err) {
          reject(err as Error);
          return;
        }
        apply(layout(result.value), "saved");
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
