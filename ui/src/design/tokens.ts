// Ruah design tokens — THE one place where the design system meets the app.
//
//   1. DESIGN_SYSTEM   the "Ruah Design System" v1.0 (Claude Design) values, verbatim.
//   2. PALETTES        how the app composes the design system's scales into its palettes.
//   3. THEMES          the app's surfaces (dark lifted above the design system's #111110).
//   4. resolveTokens   design-system roles → the app's semantic CSS tokens, per palette × theme.
//   5. CONTRAST_PAIRS  every text / UI pair the WCAG check (tests + `ruah app design check`) runs.
//
// The generated stylesheet ui/src/design/tokens.css comes from this file:
//   pnpm design:tokens            (= ruah app design css --out ui/src/design/tokens.css)
// A design update is a single edit: paste the new values into DESIGN_SYSTEM, regenerate, and run
// `pnpm test` (it fails when tokens.css is stale or a pair drops below 4.5:1 text / 3:1 UI).
// docs/design/README.md explains the mapping.
//
// Rule for accent tokens: the design system's hue and chroma are kept; where a pair would fail
// WCAG, only OKLab lightness moves (color.ts `readable`). Fills that carry no text (Phantom
// bodies, chart marks, map bars) stay the design system's exact step whenever they reach 3:1.
import { bestInk, contrast, mix, over, readable, rgba, shift, type Backdrop } from "./color.js";

// ================================================================================================
// 1. DESIGN SYSTEM — verbatim (names as in the design system's ruah-tokens.css export).
//    Reference copy: docs/design/ruah-design-system.html.
// ================================================================================================
export const DESIGN_SYSTEM = {
  version: "1.0",
  palettes: {
    /** Teal brand, lavender AI. */
    default: {
      "teal-200": "#88e6d7",
      "teal-300": "#4dd9c5",
      "teal-400": "#00d2b9",
      "teal-500": "#00bea8",
      "lavender-300": "#cfb9f9",
      "lavender-400": "#b594f5",
      "lavender-500": "#9b7ae0",
      "sage-300": "#a3c892",
      "sage-400": "#7fb069",
      "sage-500": "#5d9149",
      "amber-400": "#e5a84b",
      "coral-400": "#f07068",
      "slate-300": "#8a97b0",
      "slate-400": "#5b6b88",
      "slate-500": "#465068",
    },
    /** Indigo primary, dusty rose AI, sage-lime, amber, soft coral. */
    dusk: {
      "teal-200": "#c2cfff",
      "teal-300": "#9aabff",
      "teal-400": "#6578ff",
      "teal-500": "#4d5ee5",
      "lavender-300": "#f0c2d8",
      "lavender-400": "#d983b0",
      "lavender-500": "#b0638a",
      "sage-300": "#cde39a",
      "sage-400": "#9dc061",
      "sage-500": "#7a9b43",
      "amber-400": "#d9963d",
      "coral-400": "#d96056",
      "slate-300": "#a8adb8",
      "slate-400": "#6b7080",
      "slate-500": "#4a4f5c",
    },
    /** Coral brand, orange accents, teal flips to success. */
    sunrise: {
      "teal-200": "#ffd4c4",
      "teal-300": "#ff9d82",
      "teal-400": "#ff6b47",
      "teal-500": "#e24f2d",
      "lavender-300": "#ffd9a8",
      "lavender-400": "#ffa94d",
      "lavender-500": "#e08728",
      "sage-300": "#8fe6d2",
      "sage-400": "#00d2b9",
      "sage-500": "#00a890",
      "amber-400": "#ffc94d",
      "coral-400": "#c94062",
      "slate-300": "#c4a9a1",
      "slate-400": "#8a6f67",
      "slate-500": "#5d483f",
    },
  },
  themes: {
    dark: {
      bg: "#111110",
      "surface-1": "#191918",
      "surface-2": "#222221",
      "surface-3": "#2a2a28",
      "surface-4": "#333331",
      fg: "#f0eee9",
      "fg-muted": "#b8b3a8",
      "fg-subtle": "#8f8a7e",
      "fg-dim": "#706b60",
      border: "#2a2a28",
      "border-strong": "#333331",
    },
    light: {
      bg: "#faf9f7",
      "surface-1": "#f0eee9",
      "surface-2": "#e7e3dc",
      "surface-3": "#dedad3",
      "surface-4": "#b8b3a8",
      fg: "#191918",
      "fg-muted": "#565248",
      "fg-subtle": "#706b60",
      "fg-dim": "#8f8a7e",
      border: "#dedad3",
      "border-strong": "#b8b3a8",
    },
    contrast: {
      bg: "#000000",
      "surface-1": "#0a0a0a",
      "surface-2": "#141414",
      "surface-3": "#1e1e1e",
      "surface-4": "#2a2a2a",
      fg: "#ffffff",
      "fg-muted": "#e0e0e0",
      "fg-subtle": "#b0b0b0",
      "fg-dim": "#858585",
      border: "#2a2a2a",
      "border-strong": "#484848",
    },
  },
  radii: { xs: "4px", sm: "6px", md: "10px", lg: "16px", xl: "24px", pill: "999px" },
  shadows: {
    sm: "0 1px 2px rgba(0,0,0,0.3)",
    md: "0 4px 16px -4px rgba(0,0,0,0.4)",
    lg: "0 20px 60px -20px rgba(0,0,0,0.6)",
  },
  /** The Phantom's fixed character colours (tool family page). */
  phantom: { cream: "#dedad3" },
} as const;

type DsPaletteName = keyof typeof DESIGN_SYSTEM.palettes;
type DsHue = "teal" | "lavender" | "sage" | "amber" | "coral" | "slate";

/** A 4-step scale (200 tint · 300 · 400 base · 500 shade). */
export interface Scale {
  200: string;
  300: string;
  400: string;
  500: string;
}

/** A design-system scale; steps the design system leaves out (amber / coral only have 400,
 * lavender / sage / slate have no 200) are derived in OKLab from the nearest given step. */
function ds(palette: DsPaletteName, hue: DsHue): Scale {
  const p = DESIGN_SYSTEM.palettes[palette] as Record<string, string>;
  const at = (step: number) => p[`${hue}-${step}`];
  const base = at(400);
  if (!base) throw new Error(`design system has no ${hue}-400 in ${palette}`);
  const s300 = at(300) ?? shift(base, 0.06);
  return {
    200: at(200) ?? shift(s300, 0.07, 0.75),
    300: s300,
    400: base,
    500: at(500) ?? shift(base, -0.06),
  };
}

/** Step-wise OKLab blend of two scales (azure = teal × indigo). */
function blend(a: Scale, b: Scale, t = 0.5): Scale {
  return { 200: mix(a[200], b[200], t), 300: mix(a[300], b[300], t), 400: mix(a[400], b[400], t), 500: mix(a[500], b[500], t) };
}

// ================================================================================================
// 2. PALETTES — the app's palettes, composed from design-system scales.
// ================================================================================================
export type PaletteId = "teal" | "dusk" | "sunrise" | "classic";
export type ThemeId = "dark" | "light" | "contrast";
export type RoleName = "brand" | "ai" | "ok" | "warn" | "bad" | "info";

export interface PaletteSpec {
  id: PaletteId;
  label: string;
  mood: string;
  description: string;
  /** Semantic roles: brand (primary, interactive) · ai (agents, AI; the secondary accent) ·
   * ok · warn · bad · info. */
  roles: Record<RoleName, Scale>;
  /** Three categorical hues after brand and ai, never a status hue: map element kinds, chart
   * series, provider tints. */
  extra: readonly [Scale, Scale, Scale];
  /** ANSI blue / magenta / cyan sources for the terminal (red, green, yellow = bad, ok, warn). */
  ansi: { blue: Scale; magenta: Scale; cyan: Scale };
}

const TEAL = ds("default", "teal");
const LAVENDER = ds("default", "lavender");
const INDIGO = ds("dusk", "teal");
const ROSE = ds("dusk", "lavender");
const AZURE = blend(TEAL, INDIGO);

export const PALETTES: Record<PaletteId, PaletteSpec> = {
  /** Default. Teal leads (brand, actions); indigo is the secondary and the agents' colour. */
  teal: {
    id: "teal",
    label: "Teal + Indigo",
    mood: "teal / indigo",
    description: "Teal for actions and the brand, indigo for agents and AI.",
    roles: {
      brand: TEAL,
      ai: INDIGO,
      ok: ds("default", "sage"),
      warn: ds("default", "amber"),
      bad: ds("default", "coral"),
      info: ds("default", "slate"),
    },
    extra: [AZURE, ROSE, LAVENDER],
    ansi: { blue: INDIGO, magenta: ROSE, cyan: TEAL },
  },
  /** The design system's "dusk" as is. Stored as "dusk" so the first-paint boot script
   * (routes/__root.tsx THEME_BOOT) already applies it. */
  dusk: {
    id: "dusk",
    label: "Indigo",
    mood: "indigo / rose",
    description: "The design system's Dusk: indigo leads, dusty rose for agents.",
    roles: {
      brand: INDIGO,
      ai: ROSE,
      ok: ds("dusk", "sage"),
      warn: ds("dusk", "amber"),
      bad: ds("dusk", "coral"),
      info: ds("dusk", "slate"),
    },
    extra: [TEAL, AZURE, LAVENDER],
    ansi: { blue: INDIGO, magenta: ROSE, cyan: TEAL },
  },
  sunrise: {
    id: "sunrise",
    label: "Sunrise",
    mood: "coral / warm",
    description: "Warm coral leads, orange for agents; teal becomes success.",
    roles: {
      brand: ds("sunrise", "teal"),
      ai: ds("sunrise", "lavender"),
      ok: ds("sunrise", "sage"),
      warn: ds("sunrise", "amber"),
      bad: ds("sunrise", "coral"),
      info: ds("sunrise", "slate"),
    },
    extra: [INDIGO, ROSE, LAVENDER],
    ansi: { blue: INDIGO, magenta: ROSE, cyan: ds("sunrise", "sage") },
  },
  /** The design system's "default" as is (teal + lavender), the look before Teal + Indigo. */
  classic: {
    id: "classic",
    label: "Classic teal",
    mood: "teal / lavender",
    description: "The design system's default: teal with lavender for agents.",
    roles: {
      brand: TEAL,
      ai: LAVENDER,
      ok: ds("default", "sage"),
      warn: ds("default", "amber"),
      bad: ds("default", "coral"),
      info: ds("default", "slate"),
    },
    extra: [AZURE, ROSE, INDIGO],
    ansi: { blue: INDIGO, magenta: LAVENDER, cyan: TEAL },
  },
};

export const PALETTE_IDS = Object.keys(PALETTES) as PaletteId[];
export const DEFAULT_PALETTE: PaletteId = "teal";
/** Non-default palette ids, as the first-paint boot script must accept them. */
export const PALETTE_BOOT_IDS = PALETTE_IDS.filter((id) => id !== DEFAULT_PALETTE);

/** Coding agents' identity tints (palette-independent, so an agent is recognisable in every
 * palette; per theme they are only lightness-adjusted). Generic hues, never brand artwork. */
export const AGENT_TINTS = {
  claude: { label: "Claude Code", hex: "#d97757" },
  cursor: { label: "Cursor", hex: "#6fa3ec" },
  grok: { label: "Grok", hex: "#c3c9d4" },
  kiro: { label: "Kiro", hex: "#9f72f5" },
  opencode: { label: "OpenCode", hex: "#e57fb2" },
} as const;
export type AgentTint = keyof typeof AGENT_TINTS;
export const AGENT_TINT_IDS = Object.keys(AGENT_TINTS) as AgentTint[];

// ================================================================================================
// 3. THEMES — the app's surfaces. Dark is the design system's warm charcoal lifted about two
//    steps (#111110 → #20201e page) so panels and borders stay visible in long sessions (the
//    user's ask, 2026-09-23). Light and high contrast follow the design system's families.
// ================================================================================================
export interface ThemeSpec {
  id: ThemeId;
  label: string;
  scheme: "dark" | "light";
  /** Which scale step is the fill (bodies, marks) in this theme. */
  fill: 300 | 400 | 500;
  /** Step the primary button starts from. */
  primary: 300 | 400 | 500;
  /** Minimum ratio for text pairs (AA 4.5; the contrast theme holds AAA 7). */
  textRatio: number;
  /** Ink on accent fills (primary / ai / destructive buttons and chips). */
  ink: string;
  surfaces: Record<
    | "surface-0" | "background" | "surface-1" | "surface-2" | "surface-3" | "surface-4" | "hairline"
    | "card" | "popover" | "secondary" | "muted" | "accent" | "border" | "input" | "message"
    | "composer" | "canvas" | "grid" | "edge" | "group",
    string
  >;
  text: { foreground: string; "muted-foreground": string; faint: string; "node-file": string };
  /** Lightness move for agent tints (OKLab ΔL) before the 3:1 check. */
  agentShift: number;
  effects: { "elev-card": string; "elev-elevated": string; "grain-opacity": string };
  /** Phantom neutrals: eyes, the eye shine, and props (paper, ink on paper, metal / fabric
   * props, deep props, screens, the hairline around paper outside the body). */
  phantom: { eye: string; shine: string; paper: string; ink: string; prop: string; "prop-deep": string; screen: string; edge: string };
  terminal: { bg: string; fg: string; black: string; white: string; "bright-black": string; "bright-white": string };
  selectionAlpha: number;
}

export const THEMES: Record<ThemeId, ThemeSpec> = {
  dark: {
    id: "dark",
    label: "Dark",
    scheme: "dark",
    fill: 400,
    primary: 500,
    textRatio: 4.5,
    ink: "#111110",
    surfaces: {
      "surface-0": "#1a1a19",
      background: "#20201e",
      "surface-1": "#272725",
      "surface-2": "#2e2e2c",
      "surface-3": "#353533",
      "surface-4": "#3d3d3a",
      hairline: "#3a3a37",
      card: "#272725",
      popover: "#2a2a28",
      secondary: "#2e2e2c",
      muted: "#2e2e2c",
      accent: "#333331",
      border: "#3a3a37",
      input: "#77726a",
      message: "#313130",
      composer: "#2a2a28",
      canvas: "#20201e",
      grid: "#4f4b44",
      edge: "#8f8a7e",
      group: "#b8b3a8",
    },
    text: { foreground: "#f0eee9", "muted-foreground": "#b8b3a8", faint: "#8f8a7e", "node-file": "#b8b3a8" },
    agentShift: 0,
    effects: {
      "elev-card": "0 1px 2px rgba(0, 0, 0, 0.22), 0 10px 30px -14px rgba(0, 0, 0, 0.45)",
      "elev-elevated": "0 6px 24px -6px rgba(0, 0, 0, 0.45), 0 20px 50px -18px rgba(0, 0, 0, 0.5)",
      "grain-opacity": "0.03",
    },
    phantom: { eye: "#f0eee9", shine: "#1a1a19", paper: "#f0eee9", ink: "#3f3c35", prop: "#dedad3", "prop-deep": "#706b60", screen: "#262522", edge: "transparent" },
    terminal: { bg: "#1a1a19", fg: "#f0eee9", black: "#3f3c35", white: "#dedad3", "bright-black": "#8f8a7e", "bright-white": "#faf9f7" },
    selectionAlpha: 0.32,
  },
  light: {
    id: "light",
    label: "Light",
    scheme: "light",
    fill: 500,
    primary: 500,
    textRatio: 4.5,
    ink: "#ffffff",
    surfaces: {
      "surface-0": "#f3f1ec",
      background: "#faf9f7",
      "surface-1": "#f6f4ef",
      "surface-2": "#efece6",
      "surface-3": "#e6e2da",
      "surface-4": "#dcd8cf",
      hairline: "#e0dcd4",
      card: "#ffffff",
      popover: "#ffffff",
      secondary: "#efece6",
      muted: "#efece6",
      accent: "#ebe8e1",
      border: "#e0dcd4",
      input: "#8f8a7e",
      message: "#efece6",
      composer: "#ffffff",
      canvas: "#faf9f7",
      grid: "#cfcac0",
      edge: "#8f8a7e",
      group: "#706b60",
    },
    text: { foreground: "#1a1a19", "muted-foreground": "#565248", faint: "#706b60", "node-file": "#565248" },
    agentShift: -0.12,
    effects: {
      "elev-card": "0 1px 2px rgba(44, 42, 37, 0.06), 0 10px 30px -16px rgba(44, 42, 37, 0.18)",
      "elev-elevated": "0 6px 24px -8px rgba(44, 42, 37, 0.16), 0 20px 50px -20px rgba(44, 42, 37, 0.2)",
      "grain-opacity": "0.025",
    },
    phantom: { eye: "#faf9f7", shine: "#1a1a19", paper: "#ffffff", ink: "#3f3c35", prop: "#565248", "prop-deep": "#2c2a25", screen: "#2c2a25", edge: "#d6d1c7" },
    terminal: { bg: "#faf9f7", fg: "#1a1a19", black: "#2c2a25", white: "#b8b3a8", "bright-black": "#706b60", "bright-white": "#dedad3" },
    selectionAlpha: 0.2,
  },
  contrast: {
    id: "contrast",
    label: "High contrast",
    scheme: "dark",
    fill: 300,
    primary: 300,
    textRatio: 7,
    ink: "#000000",
    surfaces: {
      "surface-0": "#000000",
      background: "#000000",
      "surface-1": "#0a0a0a",
      "surface-2": "#1a1a1a",
      "surface-3": "#2a2a2a",
      "surface-4": "#3a3a3a",
      hairline: "#5a5a5a",
      card: "#0a0a0a",
      popover: "#0f0f0f",
      secondary: "#1a1a1a",
      muted: "#1a1a1a",
      accent: "#262626",
      border: "#5a5a5a",
      input: "#8a8a8a",
      message: "#1a1a1a",
      composer: "#0a0a0a",
      canvas: "#000000",
      grid: "#4a4a4a",
      edge: "#b0b0b0",
      group: "#d0d0d0",
    },
    text: { foreground: "#ffffff", "muted-foreground": "#d0d0d0", faint: "#b0b0b0", "node-file": "#dedad3" },
    agentShift: 0.08,
    effects: {
      "elev-card": "0 0 0 1px #5a5a5a",
      "elev-elevated": "0 0 0 1px #8a8a8a, 0 12px 40px -12px rgba(0, 0, 0, 0.8)",
      "grain-opacity": "0",
    },
    phantom: { eye: "#000000", shine: "#ffffff", paper: "#ffffff", ink: "#000000", prop: "#ffffff", "prop-deep": "#8a8a8a", screen: "#000000", edge: "transparent" },
    terminal: { bg: "#000000", fg: "#ffffff", black: "#5a5a5a", white: "#e6e6e6", "bright-black": "#b0b0b0", "bright-white": "#ffffff" },
    selectionAlpha: 0.38,
  },
};

export const THEME_IDS = Object.keys(THEMES) as ThemeId[];

// ================================================================================================
// 4. MAPPING — design-system roles → the app's semantic tokens (CSS custom properties).
// ================================================================================================
export type Tokens = Record<string, string>;

/** Tokens that depend only on the theme. */
export function themeTokens(themeId: ThemeId): Tokens {
  const t = THEMES[themeId];
  const s = t.surfaces;
  const textBgs = [s.background, s["surface-0"], s["surface-1"], s["surface-2"], s.card, s.popover];
  const uiBgs = [s.background, s.card, s.popover, s["surface-2"]];
  const out: Tokens = { ...s };
  out["foreground"] = t.text.foreground;
  out["muted-foreground"] = t.text["muted-foreground"];
  out["faint"] = readable(t.text.faint, textBgs, t.textRatio);
  out["node-file"] = readable(t.text["node-file"], [s.background, s.card], t.textRatio);
  for (const [k, v] of Object.entries(t.effects)) out[k] = v;
  // Phantom neutrals: the eyes, the cream "Face", props (paper, ink, headset, hat…).
  out["ph-eye"] = t.phantom.eye;
  out["ph-shine"] = t.phantom.shine;
  out["ph-paper"] = t.phantom.paper;
  out["ph-ink"] = t.phantom.ink;
  out["ph-prop"] = t.phantom.prop;
  out["ph-prop-deep"] = t.phantom["prop-deep"];
  out["ph-screen"] = t.phantom.screen;
  out["ph-edge"] = t.phantom.edge;
  out["ph-muted"] = readable(t.id === "light" ? "#b8b3a8" : t.id === "contrast" ? "#9a9a9a" : "#8f8a7e", uiBgs, 3);
  out["ph-cream"] = readable(t.id === "light" ? "#b8b3a8" : DESIGN_SYSTEM.phantom.cream, uiBgs, 3);
  // Agent identity tints (charts, dots, the agents' Phantoms).
  for (const id of AGENT_TINT_IDS) {
    const base = t.agentShift ? shift(AGENT_TINTS[id].hex, t.agentShift) : AGENT_TINTS[id].hex;
    out[`agent-${id}`] = readable(base, uiBgs, 3);
  }
  // Terminal neutrals.
  out["term-bg"] = t.terminal.bg;
  out["term-fg"] = t.terminal.fg;
  out["term-black"] = t.terminal.black;
  out["term-white"] = t.terminal.white;
  out["term-bright-black"] = readable(t.terminal["bright-black"], [t.terminal.bg], t.textRatio);
  out["term-bright-white"] = t.terminal["bright-white"];
  return out;
}

/** Tokens that depend on palette × theme. */
export function paletteTokens(paletteId: PaletteId, themeId: ThemeId): Tokens {
  const p = PALETTES[paletteId];
  const t = THEMES[themeId];
  const s = t.surfaces;
  const R = t.textRatio;
  const textBgs: Backdrop[] = [s.background, s["surface-0"], s["surface-1"], s["surface-2"], s.card, s.popover];
  // Pills / chips: the text colour on a 15 % tint of itself.
  const tinted: Backdrop[] = [...textBgs, (fg) => over(fg, 0.15, s.popover), (fg) => over(fg, 0.15, s.card), (fg) => over(fg, 0.15, s.background)];
  const uiBgs = [s.background, s.card, s.popover, s["surface-2"]];
  const fill = (sc: Scale) => sc[t.fill];
  /** Text colour that also carries the theme ink when used as a solid fill. */
  const accent = (hex: string) => readable(hex, [...tinted, t.ink], R);
  const text = (hex: string) => readable(hex, tinted, R);
  const ui = (hex: string) => readable(hex, uiBgs, 3);
  const r = p.roles;

  const out: Tokens = {};
  // Interactive + semantic.
  out["brand"] = text(fill(r.brand));
  out["primary"] = accent(r.brand[t.primary]);
  out["primary-foreground"] = t.ink;
  out["ring"] = out["primary"];
  out["ai"] = accent(fill(r.ai));
  out["ai-foreground"] = t.ink;
  out["destructive"] = accent(fill(r.bad));
  out["destructive-foreground"] = t.ink;
  out["ok"] = text(fill(r.ok));
  out["warn"] = text(fill(r.warn));
  out["bad"] = text(fill(r.bad));
  out["info"] = text(fill(r.info));

  // Map: element kinds use brand, ai and the categorical hues — never a status hue, so an
  // element never reads as "failing" or "warning" by its kind alone.
  out["edge-active"] = ui(fill(r.brand));
  out["node-service"] = text(fill(r.brand));
  out["node-frontend"] = text(fill(r.ai));
  out["node-data"] = text(fill(p.extra[0]));
  out["node-queue"] = text(fill(p.extra[1]));
  out["node-gateway"] = text(fill(p.extra[2]));
  out["node-external"] = text(fill(r.info));
  out["node-step"] = text(t.id === "light" ? shift(r.ai[500], -0.1) : r.ai[200]);

  // Categorical (charts, provider tints): brand, ai, three extras, info.
  const cats = [r.brand, r.ai, p.extra[0], p.extra[1], p.extra[2], r.info];
  cats.forEach((sc, i) => {
    out[`cat-${i + 1}`] = ui(fill(sc));
  });

  // Phantom bodies (3:1 against the page; the design system's exact fill when it passes).
  out["ph-brand"] = ui(fill(r.brand));
  out["ph-brand-soft"] = ui(t.id === "light" ? r.brand[400] : r.brand[200]);
  out["ph-ai"] = ui(fill(r.ai));
  out["ph-ok"] = ui(fill(r.ok));
  out["ph-warn"] = ui(fill(r.warn));
  out["ph-bad"] = ui(fill(r.bad));
  out["ph-info"] = ui(t.id === "dark" ? r.info[300] : fill(r.info));
  out["ph-extra-1"] = ui(fill(p.extra[0]));
  out["ph-extra-2"] = ui(fill(p.extra[1]));
  out["ph-extra-3"] = ui(fill(p.extra[2]));

  // Terminal ANSI (red coral · green sage · yellow amber · blue / magenta / cyan per palette).
  const tb = [t.terminal.bg];
  const normal = (sc: Scale) => readable(t.id === "light" ? shift(sc[500], -0.04) : fill(sc), tb, R);
  const bright = (sc: Scale) => readable(t.id === "light" ? sc[400] : t.id === "contrast" ? sc[200] : sc[300], tb, R);
  const ansi: [string, Scale][] = [
    ["red", r.bad],
    ["green", r.ok],
    ["yellow", r.warn],
    ["blue", p.ansi.blue],
    ["magenta", p.ansi.magenta],
    ["cyan", p.ansi.cyan],
  ];
  for (const [name, sc] of ansi) {
    out[`term-${name}`] = normal(sc);
    out[`term-bright-${name}`] = bright(sc);
  }
  out["term-cursor"] = ui(fill(r.brand));
  out["term-selection"] = rgba(fill(r.brand), t.selectionAlpha);
  return out;
}

/** Every token for one palette × theme. */
export function resolveTokens(paletteId: PaletteId, themeId: ThemeId): Tokens {
  return { ...themeTokens(themeId), ...paletteTokens(paletteId, themeId) };
}

/** Aliases that only point at other tokens (declared once; they follow any scope). */
export const ALIASES: Tokens = {
  "card-foreground": "var(--foreground)",
  "popover-foreground": "var(--foreground)",
  "secondary-foreground": "var(--foreground)",
  "accent-foreground": "var(--foreground)",
  "series-1": "var(--cat-1)",
  "series-2": "var(--cat-2)",
  "series-3": "var(--cat-3)",
  "series-4": "var(--cat-4)",
  "series-5": "var(--cat-5)",
  "series-6": "var(--cat-6)",
  sidebar: "var(--surface-0)",
  "sidebar-foreground": "var(--foreground)",
  "sidebar-primary": "var(--primary)",
  "sidebar-primary-foreground": "var(--primary-foreground)",
  "sidebar-accent": "var(--accent)",
  "sidebar-accent-foreground": "var(--foreground)",
  "sidebar-border": "var(--hairline)",
  "sidebar-ring": "var(--ring)",
};

/** Theme-independent constants. Radii keep the app's scale (buttons 8 · cards 12); the design
 * system's own radii are exposed as --ds-r-* for components that follow its kit exactly. */
export const STATIC_TOKENS: Tokens = {
  radius: "0.5rem",
  "r-xs": "4px",
  "r-sm": "8px",
  "r-md": "12px",
  "r-lg": "16px",
  "r-xl": "24px",
  "r-pill": "999px",
  ...Object.fromEntries(Object.entries(DESIGN_SYSTEM.radii).map(([k, v]) => [`ds-r-${k}`, v])),
  "font-sans-stack": '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif',
  "font-mono-stack": '"Geist Mono", ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
  "font-brand-stack": '"Jura", -apple-system, system-ui, sans-serif',
};

// ================================================================================================
// 5. CONTRAST — the pairs the WCAG check runs for every palette × theme.
//    text: 4.5:1 (7:1 in the contrast theme) · ui: 3:1 (large text, icons, marks, focus, borders
//    that identify a control).
// ================================================================================================
export interface ContrastPair {
  fg: string;
  bg: string;
  kind: "text" | "ui";
  /** The background is `fg` at this alpha over `bg` (pills, chips). */
  tint?: number;
}

const pairs = (fgs: readonly string[], bgs: readonly string[], kind: ContrastPair["kind"], tint?: number): ContrastPair[] =>
  fgs.flatMap((fg) => bgs.map((bg) => (tint === undefined ? { fg, bg, kind } : { fg, bg, kind, tint })));

const SEMANTIC = ["primary", "brand", "ai", "ok", "warn", "bad", "info", "destructive"] as const;
const NODES = ["node-service", "node-frontend", "node-data", "node-queue", "node-gateway", "node-external", "node-step", "node-file"];
const ANSI = ["red", "green", "yellow", "blue", "magenta", "cyan"];

export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  ...pairs(["foreground"], ["background", "surface-0", "surface-1", "surface-2", "surface-3", "card", "popover", "message", "composer", "accent", "muted"], "text"),
  ...pairs(["muted-foreground"], ["background", "surface-0", "surface-1", "surface-2", "card", "popover", "message", "accent"], "text"),
  ...pairs(["faint"], ["background", "surface-0", "surface-1", "surface-2", "card", "popover"], "text"),
  { fg: "primary-foreground", bg: "primary", kind: "text" },
  { fg: "ai-foreground", bg: "ai", kind: "text" },
  { fg: "destructive-foreground", bg: "destructive", kind: "text" },
  ...pairs(SEMANTIC, ["background", "surface-0", "surface-2", "card", "popover"], "text"),
  ...pairs(SEMANTIC, ["popover", "card", "background"], "text", 0.15),
  ...pairs(NODES, ["background", "card"], "text"),
  ...pairs(["term-fg", "term-bright-black", ...ANSI.flatMap((c) => [`term-${c}`, `term-bright-${c}`])], ["term-bg"], "text"),
  ...pairs(["ring", "input", "edge-active"], ["background", "card"], "ui"),
  ...pairs(["edge"], ["canvas"], "ui"),
  ...pairs(["cat-1", "cat-2", "cat-3", "cat-4", "cat-5", "cat-6"], ["background", "card", "popover"], "ui"),
  ...pairs(AGENT_TINT_IDS.map((id) => `agent-${id}`), ["background", "card", "popover"], "ui"),
  ...pairs(
    ["ph-brand", "ph-brand-soft", "ph-ai", "ph-ok", "ph-warn", "ph-bad", "ph-info", "ph-muted", "ph-cream", "ph-extra-1", "ph-extra-2", "ph-extra-3"],
    ["background", "card", "popover"],
    "ui",
  ),
  { fg: "term-cursor", bg: "term-bg", kind: "ui" },
];

export interface ContrastResult extends ContrastPair {
  palette: PaletteId;
  theme: ThemeId;
  ratio: number;
  min: number;
  pass: boolean;
}

/** Run every pair for the given palettes × themes (default: all). */
export function checkContrast(
  palettes: readonly PaletteId[] = PALETTE_IDS,
  themes: readonly ThemeId[] = THEME_IDS,
): ContrastResult[] {
  const out: ContrastResult[] = [];
  for (const palette of palettes) {
    for (const theme of themes) {
      const tokens = resolveTokens(palette, theme);
      for (const pair of CONTRAST_PAIRS) {
        const fg = tokens[pair.fg];
        const base = tokens[pair.bg];
        if (!fg || !base) throw new Error(`contrast pair ${pair.fg} on ${pair.bg}: missing token (${palette}/${theme})`);
        const bg = pair.tint === undefined ? base : over(fg, pair.tint, base);
        const ratio = contrast(fg, bg);
        const min = pair.kind === "text" ? THEMES[theme].textRatio : 3;
        out.push({ ...pair, palette, theme, ratio, min, pass: ratio >= min - 1e-9 });
      }
    }
  }
  return out;
}

/** Swatches for pickers and previews: the palette's six role colours on a theme. */
export function paletteSwatches(paletteId: PaletteId, themeId: ThemeId = "dark"): Record<RoleName, string> {
  const t = resolveTokens(paletteId, themeId);
  return {
    brand: t["ph-brand"] ?? "",
    ai: t["ph-ai"] ?? "",
    ok: t["ph-ok"] ?? "",
    warn: t["ph-warn"] ?? "",
    bad: t["ph-bad"] ?? "",
    info: t["ph-info"] ?? "",
  };
}

/** The best of the theme's inks on a colour (for ad-hoc chips). */
export function inkOn(hex: string, themeId: ThemeId): string {
  const t = THEMES[themeId];
  return bestInk(hex, [t.ink, t.text.foreground, "#111110", "#ffffff"]);
}
