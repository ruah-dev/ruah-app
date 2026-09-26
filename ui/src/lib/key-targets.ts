// Page-wide shortcuts (window keydown) must leave a focused control its own keys: Enter / Space
// press a button, arrows move inside a tab strip, radio group, menu or list. Without this the
// map's Enter drilled into the selected element instead of pressing the focused button, and the
// permission card's Enter answered "Allow" while "Reject" had the focus.

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
