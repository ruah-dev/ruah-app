// Accessibility rules that can be checked on the source (the live DOM audit in the polish report
// covers names, contrast and keyboard reach on the rendered pages):
// - an icon-only <button> carries an aria-label (a `title` alone is not announced reliably);
// - a clickable <div>/<span> is a real control (role + tabIndex), a listbox option, or on a short,
//   explained list;
// - script motion goes through lib/motion.ts, so it stops under prefers-reduced-motion;
// - the kit Segmented control moves with the arrow keys like a radio group;
// - page-wide shortcuts (map, permission card) leave a focused control its own keys.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { segmentedStep } from "@/components/ui/segmented";
import { controlOwnsKey } from "@/lib/key-targets";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(name)) out.push(p);
  }
  return out;
}

/** Folders another track owns this wave (the shell); held to these rules once they adopt them. */
const NOT_YET = [
  "components/shell/",
  "components/launcher/",
  "components/projects/",
  "components/workspace/",
  "components/dashboard/",
  "routes/__root.tsx",
  "routes/index.tsx",
];

const files = walk(join(SRC, "components"))
  .concat(walk(join(SRC, "routes")), walk(join(SRC, "lib")))
  .map((file) => ({ file, rel: relative(SRC, file).split("\\").join("/") }))
  .filter(({ rel }) => !NOT_YET.some((p) => rel.startsWith(p)))
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

  it("clickable divs and spans are real controls (role + tabIndex) or explained here", () => {
    const EXPLAINED = new Set([
      // Clicking the composer's padding focuses its textarea (which is itself focusable).
      "components/agent/Composer.tsx",
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

describe("Segmented keyboard (radio group)", () => {
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
