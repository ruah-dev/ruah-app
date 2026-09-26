// Drag pinned projects into the order you want (§20: the daemon keeps it, so ⌘1…⌘9, the rail
// and every list follow). Pointer: drag a pinned row onto another (a line shows where it lands).
// Keyboard: Alt+↑ / Alt+↓ on a focused pinned row moves it one place. Used by the Advanced
// sidebar and the All projects dialog.
import { useCallback, useState, type DragEvent, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { reorderPinned } from "@/lib/daemon";
import { dropIndex, moveId } from "@/lib/rail";

const MIME = "application/x-ruah-pinned";

export interface PinDragProps {
  draggable: true;
  onDragStart: (e: DragEvent<HTMLElement>) => void;
  onDragOver: (e: DragEvent<HTMLElement>) => void;
  onDrop: (e: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  "aria-roledescription": string;
}

export function usePinReorder(pinnedIds: readonly string[]) {
  const [drag, setDrag] = useState<{ id: string; over: string | null; after: boolean } | null>(null);

  const commit = useCallback((ids: string[]) => {
    if (ids.every((id, i) => id === pinnedIds[i])) return;
    reorderPinned(ids).catch((err: unknown) => toast.error("Couldn't reorder the pinned projects", { description: err instanceof Error ? err.message : String(err) }));
  }, [pinnedIds]);

  const rowProps = (id: string): PinDragProps | Record<string, never> => {
    if (!pinnedIds.includes(id) || pinnedIds.length < 2) return {};
    return {
      draggable: true,
      "aria-roledescription": "pinned project, Alt+Up / Alt+Down to reorder",
      onDragStart: (e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(MIME, id);
        setDrag({ id, over: null, after: false });
      },
      onDragOver: (e) => {
        if (!drag) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        // Read the event before any state update (never inside an updater).
        const rect = e.currentTarget.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        if (drag.over !== id || drag.after !== after) setDrag({ id: drag.id, over: id, after });
      },
      onDrop: (e) => {
        e.preventDefault();
        if (!drag || drag.id === id) {
          setDrag(null);
          return;
        }
        commit(moveId(pinnedIds, drag.id, dropIndex(pinnedIds, drag.id, id, drag.after)));
        setDrag(null);
      },
      onDragEnd: () => setDrag(null),
      onKeyDown: (e) => {
        if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
        e.preventDefault();
        e.stopPropagation();
        const i = pinnedIds.indexOf(id);
        commit(moveId(pinnedIds, id, i + (e.key === "ArrowUp" ? -1 : 1)));
      },
    };
  };

  /** "before" / "after" when a dragged pin would land next to `id`. */
  const indicator = (id: string): "before" | "after" | null => (drag && drag.over === id && drag.id !== id ? (drag.after ? "after" : "before") : null);

  return { rowProps, indicator, dragging: drag?.id ?? null };
}
