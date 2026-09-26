// ui/test/permission-keys.test.ts — the permission card's Enter / Esc shortcut
// (ui/src/lib/permission-keys.ts) answers only when the key can't mean anything else.
// Regression: Enter on Home's "Open Gamma" or "Reject" button approved another project's edit.
import { describe, expect, it } from "vitest";
import { permissionKeyAllowed, type KeyTargetLike } from "@/lib/permission-keys";

/** A fake element: its own selector matches plus its ancestors' (enough for `closest`). */
function el(tagName: string, opts: { attrs?: Record<string, string>; parent?: Fake; disabled?: boolean; editable?: boolean } = {}): Fake {
  const self: Fake = {
    tagName: tagName.toUpperCase(),
    ...(opts.disabled !== undefined ? { disabled: opts.disabled } : {}),
    isContentEditable: opts.editable === true,
    parent: opts.parent ?? null,
    attrs: opts.attrs ?? {},
    closest(selector: string) {
      for (let cur: Fake | null = self; cur; cur = cur.parent) if (matches(cur, selector)) return cur;
      return null;
    },
  };
  return self;
}
interface Fake extends KeyTargetLike {
  parent: Fake | null;
  attrs: Record<string, string>;
}
function matches(node: Fake, selectorList: string): boolean {
  return selectorList.split(",").some((raw) => {
    const s = raw.trim();
    const role = /^\[role=([a-z]+)\]$/.exec(s);
    if (role) return node.attrs.role === role[1];
    if (s === "a[href]") return node.tagName === "A" && "href" in node.attrs;
    if (s.startsWith("[contenteditable]")) return "contenteditable" in node.attrs && node.attrs.contenteditable !== "false";
    return node.tagName === s.toUpperCase();
  });
}

const body = el("body");
const root = el("html");
const card = el("div", { attrs: { role: "group" } });
const inCard = el("div", { parent: card });
const where = { body, root, card: { contains: (n: never) => [card, inCard].includes(n as Fake) || (n as Fake | null)?.parent === card } };
const key = (target: unknown, defaultPrevented = false) => ({ target, defaultPrevented });

describe("permission shortcut targets", () => {
  it("never takes Enter from a button — Home's card, its quick actions or anything else", () => {
    const home = el("article");
    expect(permissionKeyAllowed(key(el("button", { attrs: { "aria-label": "Open Gamma" }, parent: home })), where)).toBe(false);
    expect(permissionKeyAllowed(key(el("button", { parent: home })), where)).toBe(false); // "Reject" quick button
    expect(permissionKeyAllowed(key(el("svg", { parent: el("button", { parent: home }) })), where)).toBe(false); // an icon inside a button
    expect(permissionKeyAllowed(key(el("div", { attrs: { role: "tab" } })), where)).toBe(false);
    expect(permissionKeyAllowed(key(el("a", { attrs: { href: "/x" } })), where)).toBe(false);
    // The card's own option buttons click themselves ("Reject" must reject, not allow).
    expect(permissionKeyAllowed(key(el("button", { parent: card })), where)).toBe(false);
  });

  it("never takes a key from a field, an editor, a dialog or a menu", () => {
    expect(permissionKeyAllowed(key(el("input")), where)).toBe(false);
    expect(permissionKeyAllowed(key(el("textarea")), where)).toBe(false);
    expect(permissionKeyAllowed(key(el("div", { editable: true, attrs: { contenteditable: "true" } })), where)).toBe(false);
    expect(permissionKeyAllowed(key(el("div", { parent: el("div", { attrs: { role: "dialog" } }) })), where)).toBe(false);
    expect(permissionKeyAllowed(key(el("div", { parent: el("div", { attrs: { role: "menu" } }) })), where)).toBe(false);
    // A disabled field in a dialog is still the dialog's.
    expect(permissionKeyAllowed(key(el("textarea", { disabled: true, parent: el("div", { attrs: { role: "dialog" } }) })), where)).toBe(false);
  });

  it("never answers a key something else already handled", () => {
    expect(permissionKeyAllowed(key(body, true), where)).toBe(false);
  });

  it("answers when nothing else can take the key", () => {
    expect(permissionKeyAllowed(key(body), where)).toBe(true);
    expect(permissionKeyAllowed(key(root), where)).toBe(true);
    expect(permissionKeyAllowed(key(null), where)).toBe(true);
    expect(permissionKeyAllowed(key(el("textarea", { disabled: true })), where)).toBe(true); // the composer while the agent works
    expect(permissionKeyAllowed(key(inCard), where)).toBe(true);
    // Some other focusable, non-interactive container (the map canvas, a scroller): not ours.
    expect(permissionKeyAllowed(key(el("div", { attrs: { tabindex: "0" } })), where)).toBe(false);
    expect(permissionKeyAllowed(key(inCard), { body, root, card: null })).toBe(false);
  });
});
