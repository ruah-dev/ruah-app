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
import { useEffect, useState } from "react";
import { DEFAULT_PALETTE, PALETTE_IDS, type PaletteId } from "@/design/tokens";

export type ThemePref = "system" | "dark" | "light" | "contrast";
export type PalettePref = PaletteId;
type Mode = "dark" | "light" | "contrast";

const KEY = "ruah.theme";
const PALETTE_KEY = "ruah.palette";
/** Fired on window when a hook instance changes the theme or palette, so every switcher
 * (Settings, the shell's appearance menu) shows the same choice; other windows follow through
 * the storage event. */
const APPEARANCE_EVENT = "ruah:appearance";

function onAppearanceChange(key: string, sync: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === key) sync();
  };
  window.addEventListener(APPEARANCE_EVENT, sync);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(APPEARANCE_EVENT, sync);
    window.removeEventListener("storage", onStorage);
  };
}
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

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

export function readTheme(): ThemePref {
  return read(KEY, THEMES, "dark");
}

export function readPalette(): PalettePref {
  return read(PALETTE_KEY, PALETTES, DEFAULT_PALETTE);
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

/** The resolved light/dark scheme, for libraries that take a theme prop (toasts). */
export function useColorScheme(): "dark" | "light" {
  const [scheme, setScheme] = useState<"dark" | "light">("dark");
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setScheme(root.classList.contains("light") ? "light" : "dark");
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);
  return scheme;
}

/** Applies the stored theme on mount and keeps "system" in sync with the OS. */
export function useTheme() {
  const [pref, setPref] = useState<ThemePref>("dark");
  useEffect(() => {
    const sync = () => {
      const stored = readTheme();
      setPref(stored);
      applyTheme(stored);
    };
    sync();
    return onAppearanceChange(KEY, sync);
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
  const set = (next: ThemePref) => {
    write(KEY, next);
    setPref(next);
    applyTheme(next);
    window.dispatchEvent(new Event(APPEARANCE_EVENT));
  };
  return [pref, set] as const;
}

/** The palette (Teal + Indigo · Indigo · Sunrise · Classic teal). */
export function usePalette() {
  const [palette, setPalette] = useState<PalettePref>(DEFAULT_PALETTE);
  useEffect(() => {
    const sync = () => {
      const stored = readPalette();
      setPalette(stored);
      applyPalette(stored);
    };
    sync();
    return onAppearanceChange(PALETTE_KEY, sync);
  }, []);
  const set = (next: PalettePref) => {
    write(PALETTE_KEY, next);
    setPalette(next);
    applyPalette(next);
    window.dispatchEvent(new Event(APPEARANCE_EVENT));
  };
  return [palette, set] as const;
}
