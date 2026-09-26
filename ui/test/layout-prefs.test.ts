// ui/test/layout-prefs.test.ts — the shell layout preferences (ui/src/lib/preferences.ts: parsing,
// persistence, other windows) and what the left edge shows for them (shell/layout.ts
// resolveShellLayout: Standard rail with / without labels, Advanced sidebar, folding when narrow).
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS, PREFS_KEY, parsePrefs } from "@/lib/preferences";
import {
  ADVANCED_MIN_WIDTH,
  RAIL_WIDTH,
  RAIL_WIDTH_BARE,
  SIDEBAR_WIDTH,
  resolveShellLayout,
} from "@/components/shell/layout";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("parsePrefs", () => {
  it("defaults to the Standard layout with rail labels", () => {
    expect(DEFAULT_PREFS.layout).toBe("standard");
    expect(DEFAULT_PREFS.railLabels).toBe(true);
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs(undefined)).toEqual(DEFAULT_PREFS);
  });

  it("reads stored values and keeps older stored prefs (no layout keys yet)", () => {
    expect(parsePrefs('{"layout":"advanced","railLabels":false}')).toEqual({ ...DEFAULT_PREFS, layout: "advanced", railLabels: false });
    expect(parsePrefs('{"cloudLive":false,"resumeCard":false}')).toEqual({
      ...DEFAULT_PREFS,
      cloudLive: false,
      resumeCard: false,
    });
  });

  it("falls back per key on malformed or unknown values", () => {
    expect(parsePrefs("{not json")).toEqual(DEFAULT_PREFS);
    expect(parsePrefs("[1,2]")).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('"advanced"')).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('{"layout":"wide","railLabels":"yes","globalShortcut":true}')).toEqual({
      ...DEFAULT_PREFS,
      globalShortcut: true,
    });
  });
});

describe("viewer prefs store", () => {
  it("persists a change, skips no-op writes and applies changes from other windows", async () => {
    const store = new Map<string, string>();
    const setItem = vi.fn((k: string, v: string) => void store.set(k, v));
    const listeners: ((e: { key: string | null; newValue: string | null }) => void)[] = [];
    vi.stubGlobal("window", {
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem },
      addEventListener: (type: string, l: (e: { key: string | null; newValue: string | null }) => void) => {
        if (type === "storage") listeners.push(l);
      },
    });
    store.set(PREFS_KEY, JSON.stringify({ resumeCard: false }));
    const prefs = await import("@/lib/preferences");

    expect(prefs.viewerPrefs()).toMatchObject({ layout: "standard", railLabels: true, resumeCard: false });
    prefs.setViewerPref("layout", "advanced");
    expect(prefs.viewerPrefs().layout).toBe("advanced");
    expect(JSON.parse(store.get(PREFS_KEY)!)).toMatchObject({ layout: "advanced", resumeCard: false });
    prefs.setViewerPref("layout", "advanced");
    expect(setItem).toHaveBeenCalledTimes(1);

    // Another window turned the labels off and went back to Standard.
    expect(listeners).toHaveLength(1);
    listeners[0]!({ key: "something.else", newValue: "{}" });
    expect(prefs.viewerPrefs().layout).toBe("advanced");
    listeners[0]!({ key: PREFS_KEY, newValue: JSON.stringify({ layout: "standard", railLabels: false, resumeCard: false }) });
    expect(prefs.viewerPrefs()).toMatchObject({ layout: "standard", railLabels: false, resumeCard: false });
  });
});

describe("resolveShellLayout", () => {
  it("Standard: the 72 px labelled rail, 56 px without labels", () => {
    expect(resolveShellLayout({ layout: "standard", railLabels: true }, 1440)).toEqual({
      mode: "standard",
      effective: "standard",
      labels: true,
      folded: false,
      width: RAIL_WIDTH,
    });
    expect(RAIL_WIDTH).toBe(72);
    expect(resolveShellLayout({ layout: "standard", railLabels: false }, 1440).width).toBe(RAIL_WIDTH_BARE);
  });

  it("Advanced: the 240 px sidebar at 1280 and 1440 px, folded back to the rail when narrow", () => {
    for (const w of [1280, 1440]) {
      expect(resolveShellLayout({ layout: "advanced", railLabels: true }, w)).toMatchObject({
        effective: "advanced",
        folded: false,
        width: SIDEBAR_WIDTH,
      });
    }
    expect(SIDEBAR_WIDTH).toBe(240);
    expect(resolveShellLayout({ layout: "advanced", railLabels: false }, ADVANCED_MIN_WIDTH - 1)).toEqual({
      mode: "advanced",
      effective: "standard",
      labels: false,
      folded: true,
      width: RAIL_WIDTH_BARE,
    });
  });
});
