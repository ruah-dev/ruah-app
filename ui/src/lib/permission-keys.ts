// When a window-level Enter / Esc may answer the waiting permission (PermissionCard: Enter =
// allow once, Esc = dismiss). Only when the key cannot mean anything else: nothing has focus (the
// key lands on <body>), a disabled field has it (the composer while the turn runs), or the focus
// sits on a non-interactive part of the permission card itself. A key on any button, link, tab,
// field, menu or dialog belongs to that control — Enter on Home's "Open Gamma" or "Reject" must
// click that button, never approve another project's edit. Unit-tested in
// ui/test/permission-keys.test.ts.

/** The part of an Element this rule reads (a plain object in tests). */
export interface KeyTargetLike {
  tagName?: string;
  disabled?: boolean;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

/** Dialogs and menus own their keys (the new project wizard's Enter / Esc, a dropdown's Esc). */
const OWNS_KEYS = "[role=dialog], [role=alertdialog], [role=menu], [role=listbox]";

/** Anything Enter / Esc already means something on. */
const INTERACTIVE = [
  "button",
  "a[href]",
  "input",
  "textarea",
  "select",
  "summary",
  "[contenteditable]:not([contenteditable=false])",
  ...[
    "button",
    "link",
    "tab",
    "option",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "checkbox",
    "radio",
    "switch",
    "slider",
    "textbox",
    "combobox",
    "searchbox",
    "treeitem",
    "gridcell",
  ].map((r) => `[role=${r}]`),
].join(", ");

export function permissionKeyAllowed(
  e: { defaultPrevented: boolean; target: unknown },
  where: { body?: unknown; root?: unknown; card?: { contains: (node: never) => boolean } | null },
): boolean {
  if (e.defaultPrevented) return false;
  const t = e.target;
  // Nothing focused: the key can only mean the permission.
  if (t === null || t === undefined || t === where.body || t === where.root) return true;
  if (typeof t !== "object") return false;
  const el = t as KeyTargetLike;
  if (typeof el.closest !== "function") return false;
  if (el.closest(OWNS_KEYS)) return false;
  if (el.isContentEditable) return false;
  // A disabled field takes no keys (the composer while the agent works).
  if (el.tagName && /^(input|textarea|select)$/i.test(el.tagName) && el.disabled === true) return true;
  if (el.closest(INTERACTIVE)) return false;
  return where.card?.contains(t as never) === true;
}
