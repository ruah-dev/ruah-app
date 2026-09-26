// Regression: the Extensions nav entry was still marked optional after routes/extensions.tsx
// landed, so the Keyboard shortcuts sheet's "G then a letter" list left out "E Extensions"
// (G E worked). The sheet also lists map undo since the map has its own edit history.
import { describe, expect, it } from "vitest";
import { NAV, SHORTCUTS } from "@/components/shell/nav";

describe("keyboard shortcuts sheet", () => {
  it("lists every page's G-letter", () => {
    const go = SHORTCUTS.find((s) => s.keys === "G then a letter")?.label ?? "";
    for (const n of NAV) expect(go, n.label).toContain(`${n.key.toUpperCase()} ${n.label}`);
    expect(go).toContain("E Extensions");
  });
  it("lists map undo and no Esc answer for permissions", () => {
    expect(SHORTCUTS.some((s) => s.keys === "⌘Z · ⇧⌘Z" && s.group === "Map")).toBe(true);
    expect(SHORTCUTS.some((s) => s.group === "Agent" && /Esc/.test(s.keys))).toBe(false);
  });
});
