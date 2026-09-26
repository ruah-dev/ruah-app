// Page-wide shortcuts (window keydown) must leave a focused control its own keys: Enter / Space
// press a button, arrows move inside a tab strip, radio group, menu or list. Without this the
// map's Enter drilled into the selected element instead of pressing the focused button. The
// permission card's Enter / Esc follow the stricter rule in lib/permission-keys.ts.

/** Widgets that use the arrow keys themselves (and Enter / Space / Home / End). */
const COMPOSITE = [
  "tab",
  "tablist",
  "radio",
  "radiogroup",
  "option",
  "listbox",
  "menu",
  "menubar",
  "menuitem",
  "menuitemradio",
  "menuitemcheckbox",
  "slider",
  "separator",
  "tree",
  "treeitem",
  "grid",
  "gridcell",
  "combobox",
]
  .map((r) => `[role="${r}"]`)
  .join(",");

/** Controls that are pressed with Enter / Space. */
const PRESSABLE = [
  "button",
  "a[href]",
  "summary",
  'input[type="checkbox"]',
  'input[type="radio"]',
  '[role="button"]',
  '[role="link"]',
  '[role="switch"]',
  '[role="checkbox"]',
].join(",");

const PRESS_KEYS = new Set(["Enter", " "]);
const COMPOSITE_KEYS = new Set([
  ...PRESS_KEYS,
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

type Closest = { closest?: (selector: string) => unknown };

/** True when the focused element handles `key` itself, so a page-wide shortcut must not. */
export function controlOwnsKey(target: EventTarget | null, key: string): boolean {
  const el = target as Closest | null;
  if (!el || typeof el.closest !== "function") return false;
  if (COMPOSITE_KEYS.has(key) && el.closest(COMPOSITE)) return true;
  if (PRESS_KEYS.has(key) && el.closest(PRESSABLE)) return true;
  return false;
}

/** Open layers — dialogs, menus, popovers, listboxes — own every key pressed inside them. */
const LAYER = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  "[data-radix-popper-content-wrapper]",
].join(",");

/**
 * True when a page-wide shortcut (the map's Esc / arrows / Enter / letters) must leave this key
 * alone: something already handled it (a Radix menu or popover closing on Esc calls
 * preventDefault before the key bubbles to the window), it was pressed inside an open dialog,
 * menu or popover, or the focused control uses it itself (controlOwnsKey).
 */
export function pageShortcutBlocked(e: { key: string; defaultPrevented: boolean; target: EventTarget | null }): boolean {
  if (e.defaultPrevented) return true;
  const el = e.target as Closest | null;
  if (el && typeof el.closest === "function" && el.closest(LAYER)) return true;
  return controlOwnsKey(e.target, e.key);
}
