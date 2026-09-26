// Phantom — the Ruah mascot, ported from the ruah website (MIT, same authors):
//   ruah-website/src/components/brand/phantom.tsx          (expressions, eye shapes, eye offsets)
//   ruah-website/src/components/brand/mascot-companion.tsx (cursor-following eyes)
//   ruah-website/src/components/brand/logo.tsx             (the body path)
// The website animates with framer-motion; here all motion is plain CSS (styles.css, "Phantom"),
// so many ghosts on screen stay cheap: transforms / opacity only, no JS per frame except the
// companion's eyes, which follow the pointer on a throttled rAF and stop while offscreen.
// Motion is off under prefers-reduced-motion and in the high-contrast theme (static mode), and
// paused while the tab is hidden.
//
// Expressions map to the palette's semantic roles (design/tokens.ts; Teal + Indigo shown):
//   idle brand (teal) · thinking ai (indigo) · tracking brand + cursor-following eyes ·
//   agent ai · success ok (sage) · loading soft (mint, as in the design system) ·
//   warning warn (amber) · error bad (coral).
// Poses (sleeping, reading, terminal, …), group scenes and the agents' own tinted ghosts are in
// ./PhantomPose.tsx; everything is exported from ./index.ts.
import { useEffect, useId, useRef, type CSSProperties } from "react";
import { useAppearanceKey } from "@/lib/theme";
import { RUAH_BODY_PATH } from "@/components/brand/RuahLogo";
import { AGENT_TINT_IDS, type AgentTint } from "@/design/tokens";
import { cn } from "@/lib/utils";
import { prefersReducedMotion } from "@/lib/motion";

export type PhantomExpression =
  | "idle"
  | "thinking"
  | "tracking"
  | "agent"
  | "success"
  | "loading"
  | "warning"
  | "error";

export type EyeShape = "round" | "arc" | "line" | "squint" | "sparkle" | "cross";
/** Body colours that follow the palette: brand · ai · ok · warn · bad · info · soft (brand
 * tint, "mint") · extra-1…3 (the palette's categorical hues) · muted · cream ("The Face"). */
export type SemanticTone =
  | "brand"
  | "ai"
  | "ok"
  | "warn"
  | "bad"
  | "info"
  | "soft"
  | "extra-1"
  | "extra-2"
  | "extra-3"
  | "muted"
  | "cream";
/** Legacy names from before the palettes: teal = brand, lavender = ai, sage = ok, amber = warn,
 * coral = bad, slate = info, mint = soft (they follow the palette too). */
export type LegacyTone = "teal" | "lavender" | "sage" | "amber" | "coral" | "slate" | "mint";
/** Body colour; each expression has one, `tone` overrides it (e.g. "muted" for a cold agent,
 * "claude" for Claude's own ghost). */
export type PhantomTone = SemanticTone | AgentTint | LegacyTone;
export type CanonicalTone = SemanticTone | AgentTint;
export type PhantomSize = "xs" | "sm" | "md" | "lg" | "xl";

const LEGACY: Record<LegacyTone, SemanticTone> = {
  teal: "brand",
  lavender: "ai",
  sage: "ok",
  amber: "warn",
  coral: "bad",
  slate: "info",
  mint: "soft",
};

export const SEMANTIC_TONES: readonly SemanticTone[] = [
  "brand",
  "ai",
  "ok",
  "warn",
  "bad",
  "info",
  "soft",
  "extra-1",
  "extra-2",
  "extra-3",
  "muted",
  "cream",
];

export function canonicalTone(tone: PhantomTone): CanonicalTone {
  return (LEGACY as Record<string, SemanticTone>)[tone] ?? (tone as CanonicalTone);
}

/** The CSS custom property that holds a tone's body colour. */
export function toneVar(tone: PhantomTone): string {
  const t = canonicalTone(tone);
  if ((AGENT_TINT_IDS as readonly string[]).includes(t)) return `--agent-${t}`;
  if (t === "soft") return "--ph-brand-soft";
  return `--ph-${t}`;
}

export const PHANTOM_EXPRESSIONS: readonly PhantomExpression[] = [
  "idle",
  "thinking",
  "tracking",
  "agent",
  "success",
  "loading",
  "warning",
  "error",
];

export const PHANTOM_SIZES: Record<PhantomSize, number> = { xs: 16, sm: 24, md: 40, lg: 72, xl: 120 };

export const EXPRESSION_CONFIG: Record<PhantomExpression, { tone: CanonicalTone; eye: EyeShape }> = {
  idle: { tone: "brand", eye: "round" },
  thinking: { tone: "ai", eye: "arc" },
  tracking: { tone: "brand", eye: "round" },
  agent: { tone: "ai", eye: "round" },
  success: { tone: "ok", eye: "arc" },
  loading: { tone: "soft", eye: "squint" },
  warning: { tone: "warn", eye: "line" },
  error: { tone: "bad", eye: "cross" },
};

export const EYES_X = [237, 363] as const;
export const EYE_Y = 355.2;

/** Small ghosts get bigger eyes and bolder strokes, so the face still reads at 16 px (at the
 * website's proportions a drawn eye would be a fifth of a pixel thick). */
export function eyeScale(px: number): { k: number; sw: number } {
  if (px <= 20) return { k: 1.6, sw: 30 };
  if (px < 32) return { k: 1.3, sw: 16 };
  if (px < 56) return { k: 1.1, sw: 10 };
  return { k: 1, sw: 8 };
}

/** One eye at (cx, EYE_Y). Round / sparkle eyes follow the offset fully, the drawn ones at 0.3
 * (as on the website). The offset comes from the --ph-ex / --ph-ey custom properties, so the
 * companion can move the eyes without re-rendering. */
export function Eye({ cx, shape, k = 1, sw = 8 }: { cx: number; shape: EyeShape; k?: number; sw?: number }) {
  const cy = EYE_Y;
  const f = shape === "round" || shape === "sparkle" ? 1 : 0.3;
  const track: CSSProperties = {
    transform: `translate(calc(var(--ph-ex, 0) * ${f}px), calc(var(--ph-ey, 0) * ${f}px))`,
  };
  const stroke = {
    className: "phantom-stroke",
    strokeWidth: sw,
    strokeLinecap: "round" as const,
    fill: "none",
  };
  let eye;
  switch (shape) {
    case "round":
      eye = <ellipse cx={cx} cy={cy} rx={24.4 * k} ry={31.5 * k} className="phantom-fill" />;
      break;
    case "arc":
      // Upper arc: a happy / content eye.
      eye = (
        <path
          d={`M ${cx - 24 * k} ${cy + 4 * k} Q ${cx} ${cy - 26 * k} ${cx + 24 * k} ${cy + 4 * k}`}
          {...stroke}
        />
      );
      break;
    case "line":
      eye = <line x1={cx - 20 * k} y1={cy} x2={cx + 20 * k} y2={cy} {...stroke} />;
      break;
    case "squint":
      eye = <line x1={cx - 22 * k} y1={cy + 6 * k} x2={cx + 22 * k} y2={cy - 6 * k} {...stroke} />;
      break;
    case "sparkle":
      eye = (
        <g className="phantom-fill">
          <ellipse cx={cx} cy={cy} rx={24.4 * k} ry={31.5 * k} />
          <circle cx={cx - 8 * k} cy={cy - 12 * k} r={6 * k} className="phantom-shine" />
        </g>
      );
      break;
    case "cross":
      eye = (
        <g {...stroke} strokeWidth={sw * 0.9}>
          <line x1={cx - 16 * k} y1={cy - 16 * k} x2={cx + 16 * k} y2={cy + 16 * k} />
          <line x1={cx - 16 * k} y1={cy + 16 * k} x2={cx + 16 * k} y2={cy - 16 * k} />
        </g>
      );
      break;
  }
  return (
    <g className="phantom-eye" style={track}>
      {eye}
    </g>
  );
}

// Sprite rendering (`sprite`): the ghost as one background image with the theme colours baked
// in (read from the --ph-* tokens), cached per theme × tone × eyes. An image paints like an icon;
// on the map, where up to hundreds of agent-made elements can be on screen, that keeps panning
// as cheap as the old lavender dot (inline SVG or CSS masks cost noticeably more there).
const eyeMarkup = (cx: number, shape: EyeShape, eye: string, body: string, k: number, sw: number) => {
  const cy = EYE_Y;
  const s = `stroke='${eye}' stroke-width='${sw}' stroke-linecap='round' fill='none'`;
  switch (shape) {
    case "round":
      return `<ellipse fill='${eye}' cx='${cx}' cy='${cy}' rx='${24.4 * k}' ry='${31.5 * k}'/>`;
    case "sparkle":
      return `<ellipse fill='${eye}' cx='${cx}' cy='${cy}' rx='${24.4 * k}' ry='${31.5 * k}'/><circle fill='${body}' fill-opacity='0.5' cx='${cx - 8 * k}' cy='${cy - 12 * k}' r='${6 * k}'/>`;
    case "arc":
      return `<path d='M ${cx - 24 * k} ${cy + 4 * k} Q ${cx} ${cy - 26 * k} ${cx + 24 * k} ${cy + 4 * k}' ${s}/>`;
    case "line":
      return `<line x1='${cx - 20 * k}' y1='${cy}' x2='${cx + 20 * k}' y2='${cy}' ${s}/>`;
    case "squint":
      return `<line x1='${cx - 22 * k}' y1='${cy + 6 * k}' x2='${cx + 22 * k}' y2='${cy - 6 * k}' ${s}/>`;
    case "cross":
      return `<g ${s} stroke-width='${sw * 0.9}'><line x1='${cx - 16 * k}' y1='${cy - 16 * k}' x2='${cx + 16 * k}' y2='${cy + 16 * k}'/><line x1='${cx - 16 * k}' y1='${cy + 16 * k}' x2='${cx + 16 * k}' y2='${cy - 16 * k}'/></g>`;
  }
};

const sprites = new Map<string, string>();
function spriteUrl(theme: string, tone: PhantomTone, eyes: EyeShape, px: number): string {
  const { k, sw } = eyeScale(px);
  const key = `${theme}|${tone}|${eyes}|${k}`;
  let url = sprites.get(key);
  if (url) return url;
  const css = getComputedStyle(document.documentElement);
  const body = css.getPropertyValue(toneVar(tone)).trim() || "#00d2b9";
  const eye = css.getPropertyValue("--ph-eye").trim() || "#f0eee9";
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 600 600'><path fill='${body}' d='${RUAH_BODY_PATH}'/>` +
    EYES_X.map((cx) => eyeMarkup(cx, eyes, eye, body, k, sw)).join("") +
    `</svg>`;
  url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  sprites.set(key, url);
  return url;
}

function PhantomSprite({ tone, eyes, px }: { tone: PhantomTone; eyes: EyeShape; px: number }) {
  // The resolved theme × palette (one shared <html> observer, lib/theme.ts).
  const theme = useAppearanceKey();
  return <span className="phantom-sprite" style={{ backgroundImage: spriteUrl(theme, tone, eyes, px) }} />;
}

/** A stable pseudo-random phase per instance, so a screen full of ghosts does not blink in sync. */
export function phaseOf(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ((Math.abs(h) % 997) / 997) * 6;
}

// While the tab is hidden every ghost pauses (one listener for the whole app).
let visibilityHooked = false;
export function hookVisibility() {
  if (visibilityHooked || typeof document === "undefined") return;
  visibilityHooked = true;
  const sync = () => {
    if (document.hidden) document.documentElement.dataset["pageHidden"] = "";
    else delete document.documentElement.dataset["pageHidden"];
  };
  document.addEventListener("visibilitychange", sync);
  sync();
}

export interface PhantomProps {
  expression?: PhantomExpression | undefined;
  /** xs 16 · sm 24 · md 40 · lg 72 · xl 120, or px. */
  size?: PhantomSize | number | undefined;
  /** Override the expression's eye shape. */
  eyes?: EyeShape | undefined;
  /** Override the expression's body colour. */
  tone?: PhantomTone | undefined;
  /** Eye direction in viewBox units (600 wide); the companion drives this through CSS instead. */
  eyeOffsetX?: number | undefined;
  eyeOffsetY?: number | undefined;
  /** No idle drift (drift is on by default from md up). */
  noFloat?: boolean | undefined;
  /** No ambient glow (glow is on by default from lg up). */
  noGlow?: boolean | undefined;
  /** No motion at all (static placements, dense surfaces like the map). */
  still?: boolean | undefined;
  /** Render as one cached background image instead of inline SVG: for dense surfaces (the
   * map). No eye tracking or eye / body animation; `size` may then also be a CSS length
   * through `style` (width / height). */
  sprite?: boolean | undefined;
  /** When the ghost carries meaning, its label (role="img"); otherwise it is decorative. */
  label?: string | undefined;
  className?: string | undefined;
  style?: CSSProperties | undefined;
}

export function Phantom({
  expression = "idle",
  size = "md",
  eyes,
  tone,
  eyeOffsetX,
  eyeOffsetY,
  noFloat = false,
  noGlow = false,
  still = false,
  sprite = false,
  label,
  className,
  style,
}: PhantomProps) {
  const px = typeof size === "number" ? size : PHANTOM_SIZES[size];
  const cfg = EXPRESSION_CONFIG[expression];
  const eye = eyes ?? cfg.eye;
  const id = useId();
  useEffect(hookVisibility, []);
  const float = !still && !noFloat && px >= 40;
  const glow = !noGlow && px >= 72;
  // Blinking animates an SVG group (main-thread paint), so the tiniest ghosts (status pills,
  // toasts, map marks) skip it; drift is a composited transform on an HTML box.
  const blink = !still && !sprite && px >= 24 && (eye === "round" || eye === "sparkle");
  const vars = {
    width: px,
    height: px,
    "--ph-delay": `-${phaseOf(id).toFixed(2)}s`,
    ...(eyeOffsetX !== undefined ? { "--ph-ex": eyeOffsetX } : {}),
    ...(eyeOffsetY !== undefined ? { "--ph-ey": eyeOffsetY } : {}),
    ...style,
  } as CSSProperties;
  return (
    <span
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      data-expression={expression}
      data-tone={tone ? canonicalTone(tone) : cfg.tone}
      data-still={still ? "" : undefined}
      data-blink={blink ? "" : undefined}
      className={cn("phantom", className)}
      style={vars}
    >
      {glow ? <span aria-hidden className="phantom-glow" /> : null}
      <span className={cn("phantom-drift", float && "phantom-float")}>
        {sprite ? (
          <PhantomSprite tone={tone ?? cfg.tone} eyes={eye} px={px} />
        ) : (
        <svg viewBox="0 0 600 600" width={px} height={px} aria-hidden="true" className="phantom-body">
          <path d={RUAH_BODY_PATH} className="phantom-skin" />
          <g className="phantom-eyes">
            {EYES_X.map((cx) => (
              <Eye key={cx} cx={cx} shape={eye} {...eyeScale(px)} />
            ))}
          </g>
        </svg>
        )}
      </span>
    </span>
  );
}


/**
 * Phantom whose eyes follow the pointer (the website's MascotCompanion, without the roaming).
 * Pointer events are coalesced to one update per animation frame; the element's rect is cached
 * (refreshed on resize / scroll only), and the offset is written as two custom properties, so a
 * move costs no React render and no layout. Nothing is listened to while the ghost is offscreen,
 * the tab is hidden, motion is reduced or the high-contrast (static) theme is on.
 */
export function PhantomCompanion({
  size = "lg",
  expression = "tracking",
  maxOffset = 30,
  label,
  className,
  ...rest
}: Omit<PhantomProps, "eyeOffsetX" | "eyeOffsetY"> & { maxOffset?: number }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof window === "undefined") return;
    let rect: DOMRect | null = null;
    let frame = 0;
    let listening = false;
    let x = 0;
    let y = 0;
    const staticMode = () =>
      prefersReducedMotion() || document.documentElement.dataset["theme"] === "contrast";
    const apply = () => {
      frame = 0;
      if (staticMode()) {
        el.style.removeProperty("--ph-ex");
        el.style.removeProperty("--ph-ey");
        return;
      }
      rect ??= el.getBoundingClientRect();
      const dx = x - (rect.left + rect.width / 2);
      const dy = y - (rect.top + rect.height / 2);
      const d = Math.hypot(dx, dy);
      if (d < 1) return;
      const k = (Math.min(d / 260, 1) * maxOffset) / d;
      el.style.setProperty("--ph-ex", (dx * k).toFixed(1));
      el.style.setProperty("--ph-ey", (dy * k * 0.7).toFixed(1));
    };
    const onMove = (e: PointerEvent) => {
      x = e.clientX;
      y = e.clientY;
      if (!frame) frame = requestAnimationFrame(apply);
    };
    const invalidate = () => {
      rect = null;
    };
    const listen = (on: boolean) => {
      if (on === listening) return;
      listening = on;
      if (on) window.addEventListener("pointermove", onMove, { passive: true });
      else window.removeEventListener("pointermove", onMove);
    };
    let inView = true;
    const sync = () => listen(inView && !document.hidden);
    const io = new IntersectionObserver((entries) => {
      inView = entries.some((e) => e.isIntersecting);
      invalidate();
      sync();
    });
    io.observe(el);
    const ro = new ResizeObserver(invalidate);
    ro.observe(el);
    window.addEventListener("resize", invalidate);
    window.addEventListener("scroll", invalidate, { capture: true, passive: true });
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      listen(false);
      io.disconnect();
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", invalidate);
      window.removeEventListener("scroll", invalidate, { capture: true });
      document.removeEventListener("visibilitychange", sync);
    };
  }, [maxOffset]);
  return (
    <span ref={ref} data-tracking="" className={cn("inline-flex", className)}>
      <Phantom size={size} expression={expression} {...(label ? { label } : {})} {...rest} />
    </span>
  );
}
