// Theme + palette (Settings → Appearance), in the Ruah design system (design/tokens.ts).
//   theme:   dark (default; the brand's warm charcoal, lifted so it stays clearly visible —
//            the user asked for "dark, but more visible", 2026-09-23) · light (the brand's warm
//            light) · contrast (the brand's high-contrast theme) · system (follows the OS).
//   palette: teal = "Teal + Indigo" (default: teal brand, indigo for agents / AI) · dusk =
//            "Indigo" (the design system's Dusk) · sunrise · classic (the design system's
//            default, teal + lavender). A palette recolours every role, not just the accent.
// The root element carries `class="dark|light"` (Tailwind `dark:` variants), `data-theme` and
// `data-palette` (absent for the default). THEME_BOOT in routes/__root.tsx applies the same
// before first paint; it must accept every id in PALETTE_BOOT_IDS (design/tokens.ts).
//
// Each preference is a small in-memory store (the value chosen in this session is the truth;
// localStorage only persists it), so every switcher — Settings, the shell's appearance menu, the
// command launcher — shows the same choice, a choice still applies when storage is unavailable,
// and a theme change never re-applies the palette (or the reverse). Other windows follow through
// the `storage` event.
import { useEffect, useSyncExternalStore } from "react";
import { DEFAULT_PALETTE, PALETTE_IDS, type PaletteId } from "@/design/tokens";

export type ThemePref = "system" | "dark" | "light" | "contrast";
export type PalettePref = PaletteId;
type Mode = "dark" | "light" | "contrast";

const KEY = "ruah.theme";
const PALETTE_KEY = "ruah.palette";
/** Set once a palette has been chosen (or the Dusk → Indigo note dismissed) since `dusk` came to
 * mean the design system's Indigo palette; a stored `dusk` without it was picked as the old
 * lavender accent (CONTRACTS §15.1). */
const PALETTE_VERSION_KEY = "ruah.palette.v";
const PALETTE_VERSION = "2";
const THEMES: readonly ThemePref[] = ["system", "dark", "light", "contrast"];
const PALETTES: readonly PalettePref[] = PALETTE_IDS;

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = window.localStorage.getItem(key);
    return allowed.includes(v as T) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the choice holds for this session */
  }
}

function resolve(pref: ThemePref): Mode {
  if (pref !== "system") return pref;
  if (window.matchMedia("(prefers-contrast: more)").matches) return "contrast";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(pref: ThemePref) {
  const mode = resolve(pref);
  const scheme = mode === "light" ? "light" : "dark";
  const root = document.documentElement;
  root.classList.toggle("dark", scheme === "dark");
  root.classList.toggle("light", scheme === "light");
  root.dataset["theme"] = mode;
  root.style.colorScheme = scheme;
}

export function applyPalette(palette: PalettePref) {
  const root = document.documentElement;
  if (palette === DEFAULT_PALETTE) delete root.dataset["palette"];
  else root.dataset["palette"] = palette;
}

export interface PrefStore<T extends string> {
  /** The value in effect this session (read from storage once). */
  get(): T;
  /** Choose a value: applied, persisted when storage works, and every subscriber told. */
  set(next: T): void;
  subscribe(listener: () => void): () => void;
}

/** One persisted preference. Only the `storage` event (another window) re-reads storage. */
export function createPrefStore<T extends string>(opts: {
  key: string;
  allowed: readonly T[];
  fallback: T;
  apply: (value: T) => void;
  /** Extra writes that go with a choice (e.g. the palette version marker). */
  onSet?: (value: T) => void;
}): PrefStore<T> {
  const { key, allowed, fallback, apply, onSet } = opts;
  let value: T | null = null;
  const listeners = new Set<() => void>();
  const get = (): T => {
    if (value === null) value = typeof window === "undefined" ? fallback : read(key, allowed, fallback);
    return value;
  };
  const commit = (next: T) => {
    value = next;
    apply(next);
    for (const l of [...listeners]) l();
  };
  const onStorage = (e: StorageEvent) => {
    if (e.key !== key && e.key !== null) return; // null: another window cleared storage
    const raw = e.key === null ? null : e.newValue;
    const next = allowed.includes(raw as T) ? (raw as T) : fallback;
    if (next !== get()) commit(next);
  };
  return {
    get,
    set(next) {
      write(key, next);
      onSet?.(next);
      commit(next);
    },
    subscribe(listener) {
      if (listeners.size === 0 && typeof window !== "undefined") window.addEventListener("storage", onStorage);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
      };
    },
  };
}

export const themeStore = createPrefStore<ThemePref>({ key: KEY, allowed: THEMES, fallback: "dark", apply: applyTheme });

// A stored `dusk` from before the palettes followed the design system (read once, before any
// write can add the version marker).
let legacyDusk: boolean | null = null;
const noticeListeners = new Set<() => void>();
function isLegacyDusk(): boolean {
  if (legacyDusk === null) {
    legacyDusk =
      typeof window !== "undefined" && readRaw(PALETTE_KEY) === "dusk" && readRaw(PALETTE_VERSION_KEY) === null;
  }
  return legacyDusk;
}
function settleNotice() {
  isLegacyDusk();
  write(PALETTE_VERSION_KEY, PALETTE_VERSION);
  if (legacyDusk) {
    legacyDusk = false;
    for (const l of [...noticeListeners]) l();
  }
}

export const paletteStore = createPrefStore<PalettePref>({
  key: PALETTE_KEY,
  allowed: PALETTES,
  fallback: DEFAULT_PALETTE,
  apply: applyPalette,
  onSet: settleNotice,
});

/** The saved theme preference (the session's choice once one was made). */
export function readTheme(): ThemePref {
  return themeStore.get();
}

/** The saved palette (the session's choice once one was made). */
export function readPalette(): PalettePref {
  return paletteStore.get();
}

/** The resolved light/dark scheme, for libraries that take a theme prop (toasts). */
export function useColorScheme(): "dark" | "light" {
  return useSyncExternalStore(
    subscribeAppearance,
    () => (document.documentElement.classList.contains("light") ? "light" : "dark"),
    () => "dark",
  );
}

// ---- the resolved appearance (html data-theme × data-palette), for code that caches colours ----
const appearanceListeners = new Set<() => void>();
let appearanceObserver: MutationObserver | null = null;

/** Calls `listener` whenever <html> changes theme, palette or scheme class. One observer for all. */
export function subscribeAppearance(listener: () => void): () => void {
  appearanceListeners.add(listener);
  if (!appearanceObserver && typeof MutationObserver !== "undefined" && typeof document !== "undefined") {
    appearanceObserver = new MutationObserver(() => {
      for (const l of [...appearanceListeners]) l();
    });
    appearanceObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-palette", "class"],
    });
  }
  return () => {
    appearanceListeners.delete(listener);
    if (appearanceListeners.size === 0 && appearanceObserver) {
      appearanceObserver.disconnect();
      appearanceObserver = null;
    }
  };
}

/** `"<theme>:<palette>"` in effect on <html> (e.g. `light:dusk`; the default palette is `teal`). */
export function appearanceKey(): string {
  if (typeof document === "undefined") return `dark:${DEFAULT_PALETTE}`;
  const d = document.documentElement.dataset;
  return `${d["theme"] ?? "dark"}:${d["palette"] ?? DEFAULT_PALETTE}`;
}

/** Re-renders when the resolved theme or palette changes; the value is `appearanceKey()`. */
export function useAppearanceKey(): string {
  return useSyncExternalStore(subscribeAppearance, appearanceKey, () => `dark:${DEFAULT_PALETTE}`);
}

/** Applies the stored theme on mount and keeps "system" in sync with the OS. */
export function useTheme() {
  const pref = useSyncExternalStore(themeStore.subscribe, themeStore.get, () => "dark" as ThemePref);
  useEffect(() => {
    applyTheme(themeStore.get());
  }, []);
  useEffect(() => {
    if (pref !== "system") return;
    const queries = [
      window.matchMedia("(prefers-color-scheme: light)"),
      window.matchMedia("(prefers-contrast: more)"),
    ];
    const onChange = () => applyTheme("system");
    queries.forEach((q) => q.addEventListener("change", onChange));
    return () => queries.forEach((q) => q.removeEventListener("change", onChange));
  }, [pref]);
  return [pref, themeStore.set] as const;
}

/** The palette (Teal + Indigo · Indigo · Sunrise · Classic teal). */
export function usePalette() {
  const palette = useSyncExternalStore(paletteStore.subscribe, paletteStore.get, () => DEFAULT_PALETTE);
  useEffect(() => {
    applyPalette(paletteStore.get());
  }, []);
  return [palette, paletteStore.set] as const;
}

/** True while a `dusk` saved before the palettes followed the design system is in effect: it now
 * renders the Indigo palette (it was a lavender accent), so Settings says so once. Choosing any
 * palette or `dismiss()` ends it for good. */
export function usePaletteNotice(): { show: boolean; dismiss: () => void } {
  const show = useSyncExternalStore(subscribeNotice, paletteNotice, () => false);
  return { show, dismiss: settleNotice };
}

/** Whether the Dusk → Indigo note is due (see usePaletteNotice). */
export function paletteNotice(): boolean {
  return isLegacyDusk() && paletteStore.get() === "dusk";
}

function subscribeNotice(listener: () => void): () => void {
  noticeListeners.add(listener);
  const off = paletteStore.subscribe(listener);
  return () => {
    noticeListeners.delete(listener);
    off();
  };
}

/** Dismisses the Dusk → Indigo note (keeps the palette). */
export const dismissPaletteNotice = settleNotice;
