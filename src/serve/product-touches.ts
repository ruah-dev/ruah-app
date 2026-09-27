// CONTRACTS §23.2: does a journey step's `touches` entry still point at something?
// Stored elements and architecture workflows by id; expanded folders, files and
// symbols (§1.6) through the expander, which re-reads the working tree (cached by mtime).
import { expanderFor, isExpandedId } from "../expand/index.js";
import type { ArchitectureStore } from "./architecture-store.js";

/** The resolver for the store's current architecture; undefined while none is loaded (not checked). */
export function touchResolverFor(store: ArchitectureStore): ((ref: string) => boolean) | undefined {
  const arch = store.current();
  if (arch === null) return undefined;
  const ids = new Set<string>([...arch.nodes.map((n) => n.id), ...arch.workflows.map((w) => w.id)]);
  return (ref) => {
    if (ids.has(ref)) return true;
    if (!isExpandedId(ref)) return false;
    try {
      return expanderFor(store).locate(arch, ref) !== null;
    } catch {
      return false;
    }
  };
}
