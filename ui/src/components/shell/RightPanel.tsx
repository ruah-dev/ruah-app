// The right side of the shell. The agent panel on every page but the Agent page: the Map's side
// panel (Agent · Details · Code · Properties), collapsible (agent pill, ⌘I, its own close button)
// and resizable from its left edge; the width is remembered (localStorage, and per project in the
// view state). A live preview pane, once registered (./slots.ts), shares the column as a tab.
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useWorkbench } from "@/lib/workbench";
import { PANEL_DEFAULT, PANEL_MAX, PANEL_MIN, clampPanelWidth } from "@/lib/view-restore";
import { SidePanel } from "@/components/map/MapPage";
import { cn } from "@/lib/utils";
import { Segmented } from "@/components/ui/segmented";
import type { PreviewSlotProps } from "./slots";

const KEY = "ruah.agentPanel.width";
let width = PANEL_DEFAULT;
let loaded = false;
const listeners = new Set<() => void>();

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const v = Number(window.localStorage.getItem(KEY));
    if (v) width = clampPanelWidth(v);
  } catch {
    /* storage unavailable */
  }
}

export function panelWidth(): number {
  load();
  return width;
}

export function setPanelWidth(next: number) {
  load();
  const w = clampPanelWidth(next);
  if (w === width) return;
  width = w;
  try {
    window.localStorage.setItem(KEY, String(w));
  } catch {
    /* storage unavailable */
  }
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function usePanelWidth(): number {
  return useSyncExternalStore(subscribe, panelWidth, () => PANEL_DEFAULT);
}

/**
 * The right side: the agent panel, a registered live-preview pane (./slots.ts), or both as tabs
 * ("Agent | Preview"). One width for the column.
 */
export function RightPanel({ agent, Preview }: { agent: boolean; Preview: ComponentType<PreviewSlotProps> | null }) {
  const wb = useWorkbench();
  const w = usePanelWidth();
  const drag = useRef<{ x: number; w: number } | null>(null);
  const [tab, setTab] = useState<"agent" | "preview">(Preview ? "preview" : "agent");
  // Opening the preview brings it to the front; closing it falls back to the agent.
  useEffect(() => setTab(Preview ? "preview" : "agent"), [Preview]);
  const both = agent && !!Preview;
  const shown = both ? tab : Preview && !agent ? "preview" : "agent";
  // The preview drafted a prompt ("Ask agent to fix"): bring the agent's composer to front.
  const showAgent = () => {
    if (!wb.showPanel) wb.setShowPanel(true);
    setTab("agent");
  };

  // Never wider than half the window.
  useEffect(() => {
    const fit = () => {
      const max = Math.max(PANEL_MIN, Math.floor(window.innerWidth / 2));
      if (panelWidth() > max) setPanelWidth(max);
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const x = e.clientX;
    drag.current = { x, w: panelWidth() };
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const x = e.clientX;
    const max = Math.min(PANEL_MAX, Math.floor(window.innerWidth / 2));
    setPanelWidth(Math.min(max, d.w + (d.x - x)));
  };
  const onUp = () => {
    drag.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };

  return (
    <aside aria-label="Agent panel" style={{ width: w }} className="relative flex h-full min-h-0 shrink-0 flex-col border-s border-hairline">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the agent panel"
        aria-valuemin={PANEL_MIN}
        aria-valuemax={PANEL_MAX}
        aria-valuenow={w}
        tabIndex={0}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={() => setPanelWidth(PANEL_DEFAULT)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") setPanelWidth(panelWidth() + 16);
          if (e.key === "ArrowRight") setPanelWidth(panelWidth() - 16);
        }}
        className={cn(
          "absolute inset-y-0 -start-1 z-20 w-2 cursor-col-resize outline-none",
          "after:absolute after:inset-y-0 after:start-[3px] after:w-px after:bg-transparent after:transition-colors hover:after:bg-primary/50 focus-visible:after:bg-primary/60",
        )}
      />
      {both ? (
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-hairline px-2">
          <Segmented
            kind="tabs"
            label="Right side"
            value={tab}
            onChange={setTab}
            options={[
              { value: "agent", label: "Agent" },
              { value: "preview", label: "Preview" },
            ]}
          />
        </div>
      ) : null}
      {shown === "preview" && Preview ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <Preview onAskAgent={showAgent} />
        </div>
      ) : (
        <SidePanel onClose={() => wb.setShowPanel(false)} />
      )}
    </aside>
  );
}
