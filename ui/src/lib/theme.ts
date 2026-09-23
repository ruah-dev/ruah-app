// Theme preference (Settings → Appearance). Dark is the default; "system" follows the OS.
import { useEffect, useState } from "react";

export type ThemePref = "system" | "dark" | "light";
const KEY = "ruah.theme";

export function readTheme(): ThemePref {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "light" || v === "system" || v === "dark" ? v : "dark";
  } catch {
    return "dark";
  }
}

function resolve(pref: ThemePref): "dark" | "light" {
  if (pref !== "system") return pref;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(pref: ThemePref) {
  const mode = resolve(pref);
  const root = document.documentElement;
  root.classList.toggle("dark", mode === "dark");
  root.classList.toggle("light", mode === "light");
  root.style.colorScheme = mode;
}

/** Applies the stored theme on mount and keeps "system" in sync with the OS. */
export function useTheme() {
  const [pref, setPref] = useState<ThemePref>("dark");
  useEffect(() => {
    const stored = readTheme();
    setPref(stored);
    applyTheme(stored);
  }, []);
  useEffect(() => {
    if (pref !== "system") return;
    const mql = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => applyTheme("system");
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [pref]);
  const set = (next: ThemePref) => {
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      /* storage unavailable */
    }
    setPref(next);
    applyTheme(next);
  };
  return [pref, set] as const;
}
