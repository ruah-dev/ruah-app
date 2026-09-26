// Regression: the All projects dialog says "drag a pinned one (or Alt+↑/↓) to change ⌘1…⌘9", but
// Alt+↑/↓ never reordered there: the focus stays in the filter field, whose arrows only move the
// highlight, and the row's own Alt+arrow handler never saw the key.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = readFileSync(fileURLToPath(new URL("../src/components/launcher/Launcher.tsx", import.meta.url)), "utf8");

describe("All projects dialog", () => {
  it("reorders the highlighted pinned project with Alt+↑/↓ from the filter field", () => {
    const field = src.slice(src.indexOf('placeholder="Filter by name or path…"') - 2500, src.indexOf('placeholder="Filter by name or path…"'));
    expect(field).toMatch(/e\.altKey && \(e\.key === "ArrowUp" \|\| e\.key === "ArrowDown"\)/);
    expect(field).toMatch(/reorder\.move\(p\.id, delta\)/);
  });
});
