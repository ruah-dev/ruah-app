// The design tokens (ui/src/design/tokens.ts): WCAG contrast for every palette × theme, the
// generated stylesheet in sync with the source, the design system's values carried through,
// and the `ruah app design` CLI.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrast, mix, over, readable, shift } from "../src/design/color";
import { renderTokensCss } from "../src/design/css";
import {
  AGENT_TINT_IDS,
  CONTRAST_PAIRS,
  DESIGN_SYSTEM,
  PALETTES,
  PALETTE_BOOT_IDS,
  PALETTE_IDS,
  THEME_IDS,
  checkContrast,
  paletteSwatches,
  resolveTokens,
} from "../src/design/tokens";
import { runDesign } from "../../src/design/run-design";

const TOKENS_CSS = fileURLToPath(new URL("../src/design/tokens.css", import.meta.url));

describe("colour math", () => {
  it("computes WCAG ratios", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    // #767676 on white is the classic 4.54:1.
    expect(contrast("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
  });

  it("moves only lightness until a ratio is met", () => {
    const bg = "#20201e";
    const out = readable("#6578ff", [bg], 4.5);
    expect(contrast(out, bg)).toBeGreaterThanOrEqual(4.5);
    expect(readable("#f0eee9", [bg], 4.5)).toBe("#f0eee9"); // already passes: unchanged
    const light = readable("#00bea8", ["#faf9f7"], 4.5);
    expect(contrast(light, "#faf9f7")).toBeGreaterThanOrEqual(4.5);
  });

  it("mixes and composites", () => {
    expect(mix("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mix("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(over("#ffffff", 0.5, "#000000")).toBe("#808080");
    expect(shift("#808080", 0)).toBe("#808080");
  });
});

describe("WCAG contrast of every token pair", () => {
  const results = checkContrast();

  it("checks every pair in every palette × theme", () => {
    expect(results).toHaveLength(CONTRAST_PAIRS.length * PALETTE_IDS.length * THEME_IDS.length);
  });

  for (const palette of PALETTE_IDS) {
    for (const theme of THEME_IDS) {
      it(`${palette} × ${theme}: text ≥ ${theme === "contrast" ? 7 : 4.5}:1, UI ≥ 3:1`, () => {
        const failing = results
          .filter((r) => r.palette === palette && r.theme === theme && !r.pass)
          .map((r) => `${r.fg} on ${r.tint !== undefined ? `${r.fg}/${r.tint} over ` : ""}${r.bg}: ${r.ratio.toFixed(2)} < ${r.min}`);
        expect(failing).toEqual([]);
      });
    }
  }

  it("uses the minimums the task asks for", () => {
    const dark = results.filter((r) => r.theme === "dark");
    expect(new Set(dark.filter((r) => r.kind === "text").map((r) => r.min))).toEqual(new Set([4.5]));
    expect(new Set(dark.filter((r) => r.kind === "ui").map((r) => r.min))).toEqual(new Set([3]));
  });
});

describe("mapping", () => {
  it("every palette × theme defines the same tokens", () => {
    const names = Object.keys(resolveTokens("teal", "dark")).sort();
    for (const p of PALETTE_IDS) for (const t of THEME_IDS) expect(Object.keys(resolveTokens(p, t)).sort()).toEqual(names);
  });

  it("Teal + Indigo is the default: teal leads, indigo is the agents' colour", () => {
    expect(PALETTES.teal.label).toBe("Teal + Indigo");
    const dark = resolveTokens("teal", "dark");
    // The design system's exact fills where they pass on the lifted dark page.
    expect(dark["ph-brand"]).toBe(DESIGN_SYSTEM.palettes.default["teal-400"]);
    expect(dark["ph-ai"]).toBe(DESIGN_SYSTEM.palettes.dusk["teal-400"]);
    expect(dark["cat-2"]).toBe("#6578ff");
    expect(dark["primary"]).toBe(DESIGN_SYSTEM.palettes.default["teal-500"]);
    expect(dark["ph-ok"]).toBe(DESIGN_SYSTEM.palettes.default["sage-400"]);
    expect(dark["ph-warn"]).toBe(DESIGN_SYSTEM.palettes.default["amber-400"]);
    expect(dark["ph-bad"]).toBe(DESIGN_SYSTEM.palettes.default["coral-400"]);
  });

  it("Indigo is the design system's Dusk as is", () => {
    const dark = resolveTokens("dusk", "dark");
    expect(dark["ph-brand"]).toBe(DESIGN_SYSTEM.palettes.dusk["teal-400"]);
    expect(dark["ph-ai"]).toBe(DESIGN_SYSTEM.palettes.dusk["lavender-400"]);
    expect(PALETTES.dusk.label).toBe("Indigo");
  });

  it("keeps the lifted dark surfaces", () => {
    const dark = resolveTokens("teal", "dark");
    expect(dark["background"]).toBe("#20201e");
    expect(dark["surface-0"]).toBe("#1a1a19");
  });

  it("map element kinds never use a status hue", () => {
    for (const p of PALETTE_IDS) {
      for (const t of THEME_IDS) {
        const tk = resolveTokens(p, t);
        const status = new Set([tk["ok"], tk["warn"], tk["bad"]]);
        for (const k of ["node-service", "node-frontend", "node-data", "node-queue", "node-gateway"]) {
          expect(status.has(tk[k])).toBe(false);
        }
      }
    }
  });

  it("gives each agent a distinct tint", () => {
    for (const t of THEME_IDS) {
      const tk = resolveTokens("teal", t);
      const tints = AGENT_TINT_IDS.map((a) => tk[`agent-${a}`]);
      expect(new Set(tints).size).toBe(AGENT_TINT_IDS.length);
    }
  });

  it("boot ids are the non-default palettes", () => {
    expect(PALETTE_BOOT_IDS).toEqual(PALETTE_IDS.filter((p) => p !== "teal"));
    expect(PALETTE_BOOT_IDS).toContain("dusk");
    expect(PALETTE_BOOT_IDS).toContain("sunrise");
  });

  it("swatches come from the resolved tokens", () => {
    expect(paletteSwatches("teal").brand).toBe("#00d2b9");
    expect(paletteSwatches("teal").ai).toBe("#6578ff");
  });
});

describe("generated stylesheet", () => {
  it("ui/src/design/tokens.css is up to date (run `pnpm design:tokens`)", () => {
    expect(readFileSync(TOKENS_CSS, "utf8")).toBe(renderTokensCss());
  });

  it("scopes the page and live previews", () => {
    const css = renderTokensCss();
    expect(css).toContain('html[data-theme="light"][data-palette="dusk"]');
    expect(css).toContain('[data-ruah-preview="contrast:sunrise"]');
    expect(css).toContain('[data-ruah-preview^="light:"]');
  });
});

describe("ruah app design", () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { io: { out: (t: string) => void out.push(t), err: (t: string) => void err.push(t) }, out, err };
  };

  it("check passes and reports every pair", async () => {
    const c = io();
    expect(await runDesign(["check", "--json"], c.io)).toBe(0);
    const report = JSON.parse(c.out.join("")) as { checked: number; failed: number };
    expect(report.failed).toBe(0);
    expect(report.checked).toBe(CONTRAST_PAIRS.length * PALETTE_IDS.length * THEME_IDS.length);
  });

  it("tokens prints one palette × theme", async () => {
    const c = io();
    expect(await runDesign(["tokens", "--palette", "dusk", "--theme", "light", "--json"], c.io)).toBe(0);
    const parsed = JSON.parse(c.out.join("")) as { palette: string; theme: string; tokens: Record<string, string> };
    expect(parsed.palette).toBe("dusk");
    expect(parsed.tokens["background"]).toBe("#faf9f7");
  });

  it("css --check reports a stale file", async () => {
    const ok = io();
    expect(await runDesign(["css", "--check", TOKENS_CSS], ok.io)).toBe(0);
    const stale = io();
    expect(await runDesign(["css", "--check", fileURLToPath(new URL("./design-tokens.test.ts", import.meta.url))], stale.io)).toBe(1);
  });

  it("rejects unknown palettes and commands", async () => {
    const c = io();
    expect(await runDesign(["tokens", "--palette", "neon"], c.io)).toBe(2);
    expect(c.err.join("")).toContain("unknown palette");
    expect(await runDesign(["nope"], io().io)).toBe(2);
  });
});
