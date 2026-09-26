// Renders ui/src/design/tokens.css from tokens.ts. Run `pnpm design:tokens` after editing
// tokens.ts; the test suite fails while the committed stylesheet is stale.
//
// Scopes:
//   page     — <html data-theme="dark|light|contrast" data-palette="dusk|sunrise|classic">
//              (no data-palette = the default Teal + Indigo), set by lib/theme.ts.
//   preview  — any element with data-ruah-preview="<theme>:<palette>" renders its subtree in that
//              palette × theme (Settings → Appearance live preview, the /_ghosts sheet).
import {
  ALIASES,
  DEFAULT_PALETTE,
  PALETTE_IDS,
  STATIC_TOKENS,
  THEME_IDS,
  paletteTokens,
  themeTokens,
  type PaletteId,
  type ThemeId,
  type Tokens,
} from "./tokens.js";

export const PREVIEW_ATTR = "data-ruah-preview";

const block = (selectors: readonly string[], tokens: Tokens) =>
  `${selectors.join(",\n")} {\n${Object.entries(tokens)
    .map(([k, v]) => `  --${k}: ${v};`)
    .join("\n")}\n}\n`;

function themeSelectors(theme: ThemeId): string[] {
  const page = theme === "dark" ? ":root" : `html[data-theme="${theme}"]`;
  return [page, `[${PREVIEW_ATTR}^="${theme}:"]`];
}

function paletteSelectors(palette: PaletteId, theme: ThemeId): string[] {
  const page =
    palette === DEFAULT_PALETTE
      ? theme === "dark"
        ? ":root"
        : `html[data-theme="${theme}"]`
      : `html[data-theme="${theme}"][data-palette="${palette}"]`;
  return [page, `[${PREVIEW_ATTR}="${theme}:${palette}"]`];
}

export function renderTokensCss(): string {
  const parts: string[] = [
    "/* GENERATED from ui/src/design/tokens.ts by `pnpm design:tokens` (ruah app design css).\n" +
      " * Do not edit by hand: change tokens.ts and regenerate. docs/design/README.md explains the\n" +
      " * mapping from the Ruah Design System to these tokens. */\n",
    block([":root"], STATIC_TOKENS),
    block([":root", `[${PREVIEW_ATTR}]`], ALIASES),
    `[${PREVIEW_ATTR}^="light:"] {\n  color-scheme: light;\n}\n`,
    `[${PREVIEW_ATTR}^="dark:"],\n[${PREVIEW_ATTR}^="contrast:"] {\n  color-scheme: dark;\n}\n`,
  ];
  for (const theme of THEME_IDS) {
    parts.push(`/* theme: ${theme} */\n` + block(themeSelectors(theme), themeTokens(theme)));
  }
  for (const palette of PALETTE_IDS) {
    for (const theme of THEME_IDS) {
      parts.push(`/* palette: ${palette} × ${theme} */\n` + block(paletteSelectors(palette, theme), paletteTokens(palette, theme)));
    }
  }
  return parts.join("\n");
}
