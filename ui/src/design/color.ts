// Colour math for the design tokens (ui/src/design/tokens.ts): hex parsing, WCAG 2.x contrast,
// and OKLab mixing / lightness moves. Pure functions, no DOM: the viewer, the vitest suite and
// the `ruah app design` CLI (src/design/run-design.ts) all import this file.
//
// "Readable" adjustments keep a design-system hue and chroma and move only its OKLab lightness
// until a WCAG ratio is met, so a token stays recognisably the design system's colour.

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface Lab {
  L: number;
  a: number;
  b: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function parseHex(hex: string): Rgb {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m || m[1] === undefined) throw new Error(`not a hex colour: ${hex}`);
  let h = m[1];
  if (h.length === 3) h = h.replace(/(.)/g, "$1$1");
  const n = Number.parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function toHex({ r, g, b }: Rgb): string {
  const c = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

const toLinear = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (c: number) => {
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return s * 255;
};

/** WCAG 2.x relative luminance. */
export function luminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG 2.x contrast ratio, 1–21. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function toLab(hex: string): Lab {
  const { r, g, b } = parseHex(hex);
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** OKLab → linear sRGB; null when the colour is outside the sRGB gamut. */
function labToLinear({ L, a, b }: Lab): [number, number, number] | null {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb: [number, number, number] = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const eps = 1e-4;
  return rgb.every((c) => c >= -eps && c <= 1 + eps) ? rgb : null;
}

/** OKLab → hex, reducing chroma (hue kept) until the colour fits in sRGB. */
function fromLab(lab: Lab): string {
  let { a, b } = lab;
  const L = clamp01(lab.L);
  for (let i = 0; i < 60; i++) {
    const lin = labToLinear({ L, a, b });
    if (lin) {
      const [r, g, bl] = lin.map((c) => fromLinear(clamp01(c))) as [number, number, number];
      return toHex({ r, g, b: bl });
    }
    a *= 0.94;
    b *= 0.94;
  }
  const lin = labToLinear({ L, a: 0, b: 0 }) ?? [L, L, L];
  const [r, g, bl] = lin.map((c) => fromLinear(clamp01(c))) as [number, number, number];
  return toHex({ r, g, b: bl });
}

/** Mix in OKLab: t = 0 → a, t = 1 → b. */
export function mix(a: string, b: string, t: number): string {
  const x = toLab(a);
  const y = toLab(b);
  return fromLab({ L: x.L + (y.L - x.L) * t, a: x.a + (y.a - x.a) * t, b: x.b + (y.b - x.b) * t });
}

/** Move OKLab lightness by `dL` (−1…1), keeping hue; `chroma` scales a/b (1 = unchanged). */
export function shift(hex: string, dL: number, chroma = 1): string {
  const x = toLab(hex);
  return fromLab({ L: x.L + dL, a: x.a * chroma, b: x.b * chroma });
}

/** Alpha-composite `fg` at `alpha` over an opaque `bg` (as CSS color-mix / Tailwind `/15`). */
export function over(fg: string, alpha: number, bg: string): string {
  const f = parseHex(fg);
  const g = parseHex(bg);
  return toHex({
    r: f.r * alpha + g.r * (1 - alpha),
    g: f.g * alpha + g.g * (1 - alpha),
    b: f.b * alpha + g.b * (1 - alpha),
  });
}

/** The smallest contrast of `fg` against each background (a background may depend on `fg`,
 * e.g. a pill tinted with the text colour itself). */
export type Backdrop = string | ((fg: string) => string);
export function minContrast(fg: string, backdrops: readonly Backdrop[]): number {
  let min = Infinity;
  for (const bd of backdrops) min = Math.min(min, contrast(fg, typeof bd === "string" ? bd : bd(fg)));
  return min;
}

/**
 * The design-system colour `hex`, with only its lightness moved (away from the backdrops) until
 * it reaches `ratio` against every backdrop. Unchanged when it already passes. Backdrops must
 * all be dark or all be light (one theme). Returns the extreme it reached when the ratio is
 * impossible; the contrast test reports that.
 */
export function readable(hex: string, backdrops: readonly Backdrop[], ratio: number): string {
  if (minContrast(hex, backdrops) >= ratio) return hex;
  const first = backdrops[0];
  const ref = first === undefined ? "#000000" : typeof first === "string" ? first : first(hex);
  const lighten = luminance(ref) < 0.18;
  const base = toLab(hex);
  let best = hex;
  for (let i = 1; i <= 200; i++) {
    const L = base.L + (lighten ? 1 : -1) * i * 0.004;
    if (L < 0 || L > 1) break;
    const candidate = fromLab({ L, a: base.a, b: base.b });
    best = candidate;
    if (minContrast(candidate, backdrops) >= ratio) return candidate;
  }
  return best;
}

/** Of `inks`, the one with the highest contrast on `bg`. */
export function bestInk(bg: string, inks: readonly string[]): string {
  let best = inks[0] ?? "#000000";
  for (const ink of inks) if (contrast(ink, bg) > contrast(best, bg)) best = ink;
  return best;
}

/** `rgba()` for a hex at an alpha (terminal selection, glows). */
export function rgba(hex: string, alpha: number): string {
  const { r, g, b } = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
