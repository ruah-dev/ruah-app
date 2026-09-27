import * as fs from "node:fs";
import * as path from "node:path";
import type { MapActor, MapChange } from "../contracts/map.js";
import { type ProductFile, validateProduct } from "../contracts/product.js";

// CONTRACTS §23: the open project's product.json (personas, screens, journeys), the
// sibling of architecture-store.ts. Differences: a missing file is a normal state
// (product null, no error; the first save creates it), and warnings (links into the
// code that no longer resolve) travel with every event and are re-checked when the
// architecture changes.

export type ProductChangeReason = "initial" | "changed" | "saved" | "recheck";

export interface ProductStoreEvent {
  reason: ProductChangeReason;
  revision: number;
  /** null: there is no product.json (yet). */
  product: ProductFile | null;
  warnings: string[];
  by?: MapActor;
  /** Agent ops and undos: what changed (CONTRACTS §23.5). */
  changes?: MapChange[];
}

export interface ProductStoreError {
  path: string;
  message: string;
}

export interface ProductStore {
  readonly path: string; // absolute product.json path
  readonly root: string;
  readonly revision: number;
  current(): ProductFile | null;
  warnings(): string[];
  load(): Promise<void>;
  save(product: ProductFile, meta?: { by?: MapActor; changes?: MapChange[] }): Promise<void>;
  /** Re-runs the warning checks (the architecture changed); notifies only when they differ. */
  recheck(): void;
  close(): void;
  onChange(listener: (event: ProductStoreEvent) => void): () => void;
  onError(listener: (error: ProductStoreError) => void): () => void;
}

export interface ProductStoreOptions {
  watch?: boolean;
  /**
   * Resolver for `touches` entries, asked on every validation (the map changes under
   * the product file). Returns undefined while no architecture is loaded: not checked.
   */
  touchResolver?: () => ((ref: string) => boolean) | undefined;
  /** Multi-repo systems: whether a "<repoId>/<path>" screen path exists (default: under the store's folder). */
  pathExists?: (rel: string) => boolean;
}

const WATCH_DEBOUNCE_MS = 250;

function atomicWrite(filePath: string, data: string): void {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

export function createProductStore(productPath: string, options: ProductStoreOptions = {}): ProductStore {
  const abs = path.resolve(productPath);
  const root = path.dirname(abs);
  const listeners = new Set<(event: ProductStoreEvent) => void>();
  const errorListeners = new Set<(error: ProductStoreError) => void>();
  let revision = 0;
  let current: ProductFile | null = null;
  let warnings: string[] = [];
  let watcher: fs.FSWatcher | undefined;
  let debounce: NodeJS.Timeout | undefined;
  let initial = true;
  /** Content of our own last write (the watcher's echo of it is not a change); null = we saw no file. */
  let lastSeen: string | null | undefined;

  const context = () => {
    const resolveTouch = options.touchResolver?.();
    return { root, ...(resolveTouch !== undefined ? { resolveTouch } : {}), ...(options.pathExists !== undefined ? { pathExists: options.pathExists } : {}) };
  };

  function emit(reason: ProductChangeReason, by?: MapActor, changes?: MapChange[]): void {
    revision += 1;
    const event: ProductStoreEvent = {
      reason,
      revision,
      product: current,
      warnings,
      ...(by !== undefined ? { by } : {}),
      ...(changes !== undefined ? { changes } : {}),
    };
    for (const listener of listeners) listener(event);
  }

  function emitError(message: string): void {
    for (const listener of errorListeners) listener({ path: abs, message });
  }

  function reload(reason: ProductChangeReason): void {
    let raw: string | null;
    try {
      raw = fs.readFileSync(abs, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        emitError(`cannot read ${abs}: ${(err as Error).message}`);
        return;
      }
      raw = null;
    }
    if (!initial && raw === lastSeen) return;
    lastSeen = raw;
    if (raw === null) {
      // No file (never made, or deleted): an empty state, not an error.
      if (!initial && current === null) return;
      current = null;
      warnings = [];
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        emitError(`invalid JSON in ${abs}: ${(err as Error).message}`);
        return;
      }
      const result = validateProduct(parsed, context());
      if (!result.ok) {
        // Invalid file: keep the last good revision.
        emitError(result.errors.join("; "));
        return;
      }
      current = result.value;
      warnings = result.warnings;
    }
    emit(initial ? "initial" : reason);
    initial = false;
  }

  const store: ProductStore = {
    path: abs,
    root,
    get revision() {
      return revision;
    },
    current: () => current,
    warnings: () => warnings,
    load: () =>
      new Promise<void>((resolveLoad) => {
        reload("changed");
        resolveLoad();
      }),
    save: (product, meta = {}) =>
      new Promise<void>((resolveSave, reject) => {
        const result = validateProduct(product, context());
        if (!result.ok) {
          reject(new Error(result.errors.join("; ")));
          return;
        }
        const text = `${JSON.stringify(result.value, null, 2)}\n`;
        try {
          atomicWrite(abs, text);
        } catch (err) {
          reject(err as Error);
          return;
        }
        lastSeen = text;
        initial = false;
        current = result.value;
        warnings = result.warnings;
        emit("saved", meta.by, meta.changes);
        resolveSave();
      }),
    recheck: () => {
      if (current === null) return;
      const result = validateProduct(current, context());
      if (!result.ok) return; // cannot happen for a stored value; keep what we have
      if (sameList(result.warnings, warnings)) return;
      warnings = result.warnings;
      emit("recheck");
    },
    close: () => {
      watcher?.close();
      if (debounce !== undefined) clearTimeout(debounce);
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onError: (listener) => {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
  };

  if (options.watch !== false) {
    try {
      watcher = fs.watch(root, (_eventType, filename) => {
        if (filename !== null && path.basename(abs) !== filename) return;
        if (debounce !== undefined) clearTimeout(debounce);
        debounce = setTimeout(() => {
          debounce = undefined;
          reload("changed");
        }, WATCH_DEBOUNCE_MS);
      });
    } catch {
      // Watch failures are non-fatal.
    }
  }

  return store;
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
