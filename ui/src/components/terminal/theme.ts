// The terminal follows the app theme: xterm gets the --term-* tokens of styles.css
// (resolved for the current data-theme) and is updated when the theme changes.
import type { ITheme } from "@xterm/xterm";

const KEYS: [keyof ITheme, string][] = [
  ["background", "--term-bg"],
  ["foreground", "--term-fg"],
  ["cursor", "--term-cursor"],
  ["cursorAccent", "--term-bg"],
  ["selectionBackground", "--term-selection"],
  ["black", "--term-black"],
  ["red", "--term-red"],
  ["green", "--term-green"],
  ["yellow", "--term-yellow"],
  ["blue", "--term-blue"],
  ["magenta", "--term-magenta"],
  ["cyan", "--term-cyan"],
  ["white", "--term-white"],
  ["brightBlack", "--term-bright-black"],
  ["brightRed", "--term-bright-red"],
  ["brightGreen", "--term-bright-green"],
  ["brightYellow", "--term-bright-yellow"],
  ["brightBlue", "--term-bright-blue"],
  ["brightMagenta", "--term-bright-magenta"],
  ["brightCyan", "--term-bright-cyan"],
  ["brightWhite", "--term-bright-white"],
];

export function terminalTheme(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const theme: Record<string, string> = {};
  for (const [key, variable] of KEYS) {
    const value = css.getPropertyValue(variable).trim();
    if (value) theme[key] = value;
  }
  return theme as ITheme;
}

/** Calls `onChange` whenever the app theme or accent palette changes. */
export function watchTheme(onChange: () => void): () => void {
  const mo = new MutationObserver(onChange);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-palette", "class"] });
  return () => mo.disconnect();
}
