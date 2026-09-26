// Accessibility rules that can be checked on the source (the live DOM audit in the polish report
// covers names, contrast and keyboard reach on the rendered pages):
// - an icon-only <button> / <Button> / <…Button> carries an aria-label (or the wrapper's `label`;
//   a `title` alone is not announced reliably);
// - a clickable <div>/<span> is a real control (role + tabIndex), a listbox option, or on a short,
//   explained list;
// - script motion goes through lib/motion.ts, so it stops under prefers-reduced-motion;
// - the kit Segmented control moves with the arrow keys (radio) or the focus (tabs), keeps one Tab
//   stop, and every page uses the kit's (named) one;
// - page-wide shortcuts (map, permission card) leave a focused control, an open menu / dialog and
//   a key something else already handled alone.
// Behaviour in a real DOM (the permission card and a Radix menu, focus after a click) is covered
// by the live checks in the polish report; these tests hold the rules those checks rely on.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { segmentedStep, segmentedTabStop } from "@/components/ui/segmented";
import { controlOwnsKey, pageShortcutBlocked } from "@/lib/key-targets";
import { permissionKeyAllowed } from "@/lib/permission-keys";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(name)) out.push(p);
  }
  return out;
}

// Every track is merged: the whole viewer is held to these rules (the shell, launcher, projects,
// workspace and dashboard folders used to be exempt while another track owned them).
const files = walk(join(SRC, "components"))
  .concat(walk(join(SRC, "routes")), walk(join(SRC, "lib")))
  .map((file) => ({ file, rel: relative(SRC, file).split("\\").join("/") }))
  .map(({ file, rel }) => ({ rel, text: readFileSync(file, "utf8") }));

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

// A JSX attribute list: anything but angle brackets, or a braced expression (one nesting level).
const ATTRS = String.raw`((?:[^<>{}]|\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})*?)`;

describe("accessible names", () => {
  it("icon-only buttons have an aria-label", () => {
    // <button …><Icon … /></button>, also `{cond ? <A /> : <B />}` as the only child.
    const re = new RegExp(
      String.raw`<button\b${ATTRS}>\s*(?:\{[^{}<]*\?\s*)?<([A-Z][A-Za-z0-9.]*)\b[^<>]*/>(?:\s*:\s*<[A-Z][^<>]*/>\s*\})?\s*</button>`,
      "g",
    );
    const offenders: string[] = [];
    let checked = 0;
    for (const { rel, text } of files) {
      if (!rel.endsWith(".tsx")) continue;
      for (const m of text.matchAll(re)) {
        checked++;
        const attrs = m[1] ?? "";
        if (/\baria-label(ledby)?=/.test(attrs) || /\{\s*\.\.\./.test(attrs)) continue;
        offenders.push(`${rel}:${lineOf(text, m.index ?? 0)} <${m[2]}>`);
      }
    }
    expect(checked).toBeGreaterThan(20); // the pattern still finds the app's icon buttons
    expect(offenders).toEqual([]);
  });

  it("icon-only kit Buttons and icon-button wrappers are named too", () => {
    // <Button size="icon" …><Icon /></Button> needs aria-label; wrappers (<ToolButton label=…>,
    // <IconButton label=…>) turn their `label` into the aria-label.
    const re = new RegExp(
      String.raw`<(Button|[A-Z][A-Za-z]*Button)\b${ATTRS}>\s*(?:\{[^{}<]*\?\s*)?<([A-Z][A-Za-z0-9.]*)\b[^<>]*/>(?:\s*:\s*<[A-Z][^<>]*/>\s*\})?\s*</\1>`,
      "g",
    );
    const offenders: string[] = [];
    let checked = 0;
    for (const { rel, text } of files) {
      if (!rel.endsWith(".tsx")) continue;
      for (const m of text.matchAll(re)) {
        checked++;
        const attrs = m[2] ?? "";
        if (/\baria-label(ledby)?=/.test(attrs) || /\{\s*\.\.\./.test(attrs)) continue;
        if (m[1] !== "Button" && /\blabel=/.test(attrs)) continue;
        offenders.push(`${rel}:${lineOf(text, m.index ?? 0)} <${m[1]}><${m[3]}>`);
      }
    }
    expect(checked).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });

  it("choice groups and tab lists are the kit Segmented, or handle the arrow keys themselves", () => {
    // Regression: Home's "All projects | <project>" tab list and the new project wizard's
    // Private / Public radio group were hand-rolled: no arrow keys, every item a Tab stop.
    const offenders: string[] = [];
    for (const { rel, text } of files) {
      if (!rel.endsWith(".tsx") || rel === "components/ui/segmented.tsx") continue;
      for (const m of text.matchAll(/role=["'](radiogroup|tablist)["']/g)) {
        // The container's own keyboard handling must be right there (a grid of cards, a Radix list).
        const around = text.slice(m.index ?? 0, (m.index ?? 0) + 900);
        if (/onKeyDown=/.test(around) && /Arrow/.test(around)) continue;
        offenders.push(`${rel}:${lineOf(text, m.index ?? 0)} ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("pages use the kit Segmented (its `label` is required), not the shell's unnamed fallback", () => {
    const offenders = files
      .filter(({ rel }) => rel !== "components/map/MapPage.tsx")
      .filter(({ text }) => /import\s*\{[^}]*\bSegmented\b[^}]*\}\s*from\s*["']@\/components\/map\/MapPage["']/.test(text))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  it("clickable divs and spans are real controls (role + tabIndex) or explained here", () => {
    const EXPLAINED = new Set([
      // Clicking the composer's padding focuses its textarea (which is itself focusable).
      "components/agent/Composer.tsx",
      // Same for the tag box of "Group <project>": a click on its padding focuses its input.
      "components/projects/TagsDialog.tsx",
    ]);
    const re = new RegExp(String.raw`<(div|span|li|p|section|header|td|tr)\b${ATTRS}>`, "g");
    const offenders: string[] = [];
    for (const { rel, text } of files) {
      if (!rel.endsWith(".tsx") || EXPLAINED.has(rel)) continue;
      for (const m of text.matchAll(re)) {
        const attrs = m[2] ?? "";
        if (!/\bonClick=/.test(attrs)) continue;
        if (/\brole=/.test(attrs) && /\btabIndex=/.test(attrs)) continue;
        // A listbox option: its list owns the keys (arrows / Enter), options take no Tab stop.
        if (/\brole="option"/.test(attrs)) continue;
        offenders.push(`${rel}:${lineOf(text, m.index ?? 0)} <${m[1]}>`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("reduced motion", () => {
  it("script-driven smooth scrolling asks lib/motion.ts", () => {
    const offenders = files
      .filter(({ rel, text }) => rel !== "lib/motion.ts" && /behavior:\s*["']smooth["']/.test(text))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  it("the prefers-reduced-motion query lives in lib/motion.ts only", () => {
    const offenders = files
      .filter(({ rel, text }) => rel !== "lib/motion.ts" && /matchMedia\?*\.?\(\s*["']\(prefers-reduced-motion/.test(text))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });
});

describe("Segmented keyboard (radio group / tab list)", () => {
  const none = [false, false, false];
  it("arrows move and wrap; Home / End jump", () => {
    expect(segmentedStep("ArrowRight", 0, none)).toBe(1);
    expect(segmentedStep("ArrowDown", 2, none)).toBe(0);
    expect(segmentedStep("ArrowLeft", 0, none)).toBe(2);
    expect(segmentedStep("ArrowUp", 1, none)).toBe(0);
    expect(segmentedStep("Home", 2, none)).toBe(0);
    expect(segmentedStep("End", 0, none)).toBe(2);
  });

  it("skips disabled options and ignores other keys", () => {
    expect(segmentedStep("ArrowRight", 0, [false, true, false])).toBe(2);
    expect(segmentedStep("Home", 2, [true, false, false])).toBe(1);
    expect(segmentedStep("End", 0, [false, false, true])).toBe(1);
    expect(segmentedStep("ArrowRight", 0, [false, true, true])).toBe(0);
    expect(segmentedStep("Enter", 0, none)).toBeNull();
    expect(segmentedStep("ArrowRight", 0, [])).toBeNull();
  });

  it("always leaves one Tab stop: the chosen item, else the first enabled one", () => {
    const values = ["a", "b", "c"];
    expect(segmentedTabStop(values, none, "b")).toBe(1);
    // A value that matches no option (a view that was removed) must not make the group unreachable.
    expect(segmentedTabStop(values, none, "gone")).toBe(0);
    // A chosen item that is disabled can't take focus: the first enabled one does.
    expect(segmentedTabStop(values, [true, true, false], "a")).toBe(2);
    expect(segmentedTabStop(values, [true, true, true], "a")).toBe(-1);
  });
});

// A tiny stand-in for Element.closest over a chain of { tag, attrs } (no DOM in these tests).
type FakeEl = { tag: string; attrs?: Record<string, string>; parent?: FakeEl };
function fake(chain: FakeEl) {
  const matches = (el: FakeEl, simple: string) => {
    const m = /^([a-z]*)((?:\[[^\]]+\])*)$/.exec(simple.trim());
    if (!m) return false;
    if (m[1] && m[1] !== el.tag) return false;
    for (const [, name, value] of (m[2] ?? "").matchAll(/\[([a-z-]+)(?:="([^"]*)")?\]/g)) {
      const have = el.attrs?.[name!];
      if (have === undefined || (value !== undefined && have !== value)) return false;
    }
    return true;
  };
  return {
    closest(selector: string) {
      for (let el: FakeEl | undefined = chain; el; el = el.parent)
        if (selector.split(",").some((s) => matches(el!, s))) return el;
      return null;
    },
  };
}

describe("page-wide shortcuts leave focused controls their keys", () => {
  const body = { tag: "body" };
  const button = { tag: "button", parent: body };
  const iconInButton = { tag: "svg", parent: button };
  const tab = { tag: "div", attrs: { role: "tab" }, parent: { tag: "div", attrs: { role: "tablist" }, parent: body } };
  const radio = { tag: "button", attrs: { role: "radio" }, parent: body };
  const link = { tag: "a", attrs: { href: "/usage" }, parent: body };

  it("a button owns Enter and Space, not the map's arrows or letters", () => {
    expect(controlOwnsKey(fake(button) as unknown as EventTarget, "Enter")).toBe(true);
    expect(controlOwnsKey(fake(iconInButton) as unknown as EventTarget, " ")).toBe(true);
    expect(controlOwnsKey(fake(button) as unknown as EventTarget, "ArrowDown")).toBe(false);
    expect(controlOwnsKey(fake(button) as unknown as EventTarget, "f")).toBe(false);
    expect(controlOwnsKey(fake(link) as unknown as EventTarget, "Enter")).toBe(true);
  });

  it("tabs and radios own the arrows too", () => {
    for (const el of [tab, radio]) {
      for (const k of ["Enter", " ", "ArrowLeft", "ArrowRight", "Home", "End"])
        expect(controlOwnsKey(fake(el) as unknown as EventTarget, k), k).toBe(true);
      expect(controlOwnsKey(fake(el) as unknown as EventTarget, "Escape")).toBe(false);
    }
  });

  it("nothing focused (body) or not an element: the shortcut runs", () => {
    expect(controlOwnsKey(fake(body) as unknown as EventTarget, "Enter")).toBe(false);
    expect(controlOwnsKey(null, "Enter")).toBe(false);
    expect(controlOwnsKey({} as EventTarget, "Enter")).toBe(false);
  });
});

describe("page-wide shortcuts leave keys to menus, dialogs and handled events", () => {
  // Regression: Esc that closed a Radix menu or popover (Canvas options, Filters) also cancelled
  // the agent's waiting permission and sent the map up a level — Radix dismisses in a capture
  // listener and calls preventDefault, then the key still bubbled to the window handlers.
  const body = { tag: "body" };
  const menu = { tag: "div", attrs: { role: "menu" }, parent: body };
  const menuItem = { tag: "div", attrs: { role: "menuitem" }, parent: menu };
  const popover = { tag: "div", attrs: { "data-radix-popper-content-wrapper": "" }, parent: body };
  const inPopover = { tag: "button", parent: { tag: "div", attrs: { role: "dialog" }, parent: popover } };
  const dialogBody = { tag: "div", parent: { tag: "div", attrs: { role: "dialog" }, parent: body } };
  const ev = (target: object | null, key: string, defaultPrevented = false) => ({
    key,
    defaultPrevented,
    target: (target ? fake(target as FakeEl) : null) as unknown as EventTarget | null,
  });

  it("the map ignores a key something else already handled", () => {
    expect(pageShortcutBlocked(ev(body, "Escape", true))).toBe(true);
    // The menu item may already be gone from the page when the key reaches the window.
    expect(pageShortcutBlocked(ev(null, "Escape", true))).toBe(true);
  });

  it("the map ignores keys pressed inside an open menu, popover or dialog", () => {
    for (const t of [menu, menuItem, inPopover, dialogBody]) {
      for (const k of ["Escape", "ArrowDown", "Enter", "Backspace", "f", "n"]) expect(pageShortcutBlocked(ev(t, k)), k).toBe(true);
    }
  });

  it("the map still takes its keys when nothing else can", () => {
    expect(pageShortcutBlocked(ev(body, "Escape"))).toBe(false);
    expect(pageShortcutBlocked(ev(body, "ArrowRight"))).toBe(false);
    expect(pageShortcutBlocked(ev(null, "Backspace"))).toBe(false);
  });

  it("the permission card doesn't dismiss on an Esc that closed a menu or popover", () => {
    const card = { contains: () => false };
    const where = { body: fake(body), root: null, card };
    expect(permissionKeyAllowed({ defaultPrevented: true, target: where.body }, where)).toBe(false);
    expect(permissionKeyAllowed({ defaultPrevented: false, target: fake(menuItem) }, where)).toBe(false);
    expect(permissionKeyAllowed({ defaultPrevented: false, target: fake(inPopover) }, where)).toBe(false);
    // Nothing else had the key: Enter allows (Esc answers nothing since it stopped whole turns).
    expect(permissionKeyAllowed({ defaultPrevented: false, target: where.body }, where)).toBe(true);
  });
});
