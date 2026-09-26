// Contrast of real components on their real surfaces — beyond the token pairs in
// design-tokens.test.ts. Pills / chips / badges used a translucent tint (`bg-ok/12 text-ok`),
// which takes the colour of whatever is under it: fine on the page and cards, but ~4.1:1 on
// raised panels (surface-2 / surface-3) and hovered rows (accent). They now use the opaque
// `pill-*` utilities (styles.css): the tint is mixed over the page background, so the pair
// checked here is exactly what shows on every surface.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrast, over } from "../src/design/color";
import { PALETTE_IDS, THEME_IDS, resolveTokens } from "../src/design/tokens";

const CSS = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");
const ROLES = ["brand", "primary", "ai", "ok", "warn", "bad", "info"] as const;
const TINT = 0.12;

describe("pills on any surface", () => {
  it("styles.css defines an opaque pill per role, mixed over the page background in sRGB", () => {
    for (const r of ROLES) {
      const block = new RegExp(
        `@utility pill-${r} \\{\\s*color: var\\(--${r}\\);\\s*background-color: color-mix\\(in srgb, var\\(--${r}\\) ${TINT * 100}%, var\\(--background\\)\\);\\s*\\}`,
      );
      expect(CSS, r).toMatch(block);
    }
  });

  for (const palette of PALETTE_IDS) {
    for (const theme of THEME_IDS) {
      it(`${palette} × ${theme}: role text on its pill ≥ ${theme === "contrast" ? 7 : 4.5}:1`, () => {
        const t = resolveTokens(palette, theme);
        const need = theme === "contrast" ? 7 : 4.5;
        const failing: string[] = [];
        for (const r of ROLES) {
          const fg = t[r];
          const bg = t["background"];
          if (!fg || !bg) throw new Error(`missing token ${r} / background`);
          const ratio = contrast(fg, over(fg, TINT, bg));
          if (ratio < need) failing.push(`${r} ${ratio.toFixed(2)}`);
        }
        expect(failing).toEqual([]);
      });
    }
  }

  it("a translucent tint over a raised panel is what failed (why the pills are opaque)", () => {
    const t = resolveTokens("teal", "light");
    const translucent = contrast(t["ok"]!, over(t["ok"]!, TINT, t["surface-3"]!));
    const opaque = contrast(t["ok"]!, over(t["ok"]!, TINT, t["background"]!));
    expect(translucent).toBeLessThan(4.5);
    expect(opaque).toBeGreaterThanOrEqual(4.5);
  });
});
