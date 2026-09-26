// Shell layout (Settings → Appearance, launcher, ⌘\, the control at the bottom of the rail):
// Standard = the icon rail (72 px with labels, 56 px without) with project tiles; Advanced = a
// 240 px labelled sidebar with Projects and Chats. Stored per user in the viewer preferences;
// applies at once (no reload). Narrow windows keep the rail: Advanced needs ADVANCED_MIN_WIDTH.
import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { setViewerPref, useViewerPrefs, viewerPrefs, type LayoutMode, type ViewerPrefs } from "@/lib/preferences";

export const RAIL_WIDTH = 72;
export const RAIL_WIDTH_BARE = 56;
export const SIDEBAR_WIDTH = 240;
/** Below this window width the Advanced sidebar folds back to the rail (the page needs the room). */
export const ADVANCED_MIN_WIDTH = 1100;

function subscribeResize(l: () => void) {
  window.addEventListener("resize", l);
  return () => window.removeEventListener("resize", l);
}

export function useWindowWidth(): number {
  return useSyncExternalStore(subscribeResize, () => window.innerWidth, () => 1440);
}

export interface ShellLayout {
  /** What the user chose. */
  mode: LayoutMode;
  /** What shows (Advanced folds to the rail in a narrow window). */
  effective: LayoutMode;
  /** Labels under the rail icons (Standard). */
  labels: boolean;
  /** Advanced was chosen but the window is too narrow for it. */
  folded: boolean;
  width: number;
}

/** What the left edge shows for these preferences in a window `windowWidth` px wide. Pure. */
export function resolveShellLayout(prefs: Pick<ViewerPrefs, "layout" | "railLabels">, windowWidth: number): ShellLayout {
  const folded = prefs.layout === "advanced" && windowWidth < ADVANCED_MIN_WIDTH;
  const effective: LayoutMode = folded ? "standard" : prefs.layout;
  return {
    mode: prefs.layout,
    effective,
    labels: prefs.railLabels,
    folded,
    width: effective === "advanced" ? SIDEBAR_WIDTH : prefs.railLabels ? RAIL_WIDTH : RAIL_WIDTH_BARE,
  };
}

export function useShellLayout(): ShellLayout {
  const prefs = useViewerPrefs();
  const w = useWindowWidth();
  return resolveShellLayout(prefs, w);
}

export function setLayout(mode: LayoutMode) {
  setViewerPref("layout", mode);
  if (mode === "advanced" && typeof window !== "undefined" && window.innerWidth < ADVANCED_MIN_WIDTH) {
    toast("Advanced layout is on", {
      id: "ruah-layout",
      description: `It shows when the window is at least ${ADVANCED_MIN_WIDTH} px wide; until then the rail stays.`,
    });
  }
}

/** ⌘\ — Standard ⇄ Advanced. */
export function toggleLayout() {
  setLayout(viewerPrefs().layout === "advanced" ? "standard" : "advanced");
}

export function setRailLabels(on: boolean) {
  setViewerPref("railLabels", on);
}

export const LAYOUT_SHORTCUT = "⌘\\";
