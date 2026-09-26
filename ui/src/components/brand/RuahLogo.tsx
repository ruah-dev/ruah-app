// The Ruah brand mark and wordmark, ported from the ruah website
// (ruah-website/src/components/brand/logo.tsx) without next/link.
// The spirit body is the palette's brand fill (teal in Teal + Indigo, as the design system's logo
// follows its palette) with two warm-100 eyes; the wordmark is lowercase "ruah" in Jura.
// The mascot with expressions (Phantom) lives in ./Phantom.tsx.
import { cn } from "@/lib/utils";

export const RUAH_BODY_PATH =
  "M 468.0,380.4 L 466.8,388.4 L 464.5,396.0 L 461.1,403.1 L 456.8,409.9 L 451.5,416.2 L 445.3,422.2 L 438.4,427.7 L 430.6,432.8 L 422.2,437.5 L 413.1,441.8 L 403.5,445.7 L 393.3,449.2 L 382.7,452.3 L 371.6,454.9 L 360.2,457.2 L 348.5,459.0 L 336.6,460.5 L 324.5,461.5 L 312.3,462.1 L 300.0,462.3 L 287.7,462.1 L 275.5,461.5 L 263.4,460.5 L 251.5,459.0 L 239.8,457.2 L 228.4,454.9 L 217.3,452.3 L 206.7,449.2 L 196.5,445.7 L 186.9,441.8 L 177.8,437.5 L 169.4,432.8 L 161.6,427.7 L 154.7,422.2 L 148.5,416.2 L 143.2,409.9 L 138.9,403.1 L 135.5,396.0 L 133.2,388.4 L 132.0,380.4 L 130.9,371.6 L 130.0,362.9 L 129.4,354.3 L 129.1,345.7 L 129.0,337.2 L 129.3,328.8 L 129.9,320.6 L 130.7,312.4 L 131.9,304.3 L 133.5,296.4 L 135.3,288.6 L 137.6,280.9 L 140.1,273.4 L 143.1,266.0 L 146.4,258.7 L 150.1,251.6 L 154.2,244.7 L 158.7,238.0 L 163.6,231.4 L 169.0,225.0 L 170.3,216.2 L 172.2,208.1 L 174.6,200.9 L 177.4,194.6 L 180.7,189.1 L 184.4,184.5 L 188.3,180.8 L 192.5,178.1 L 196.9,176.3 L 201.4,175.5 L 206.1,175.8 L 210.7,177.0 L 215.4,179.3 L 220.0,182.7 L 224.4,187.2 L 228.7,193.9 L 233.2,199.5 L 237.7,203.9 L 242.3,207.1 L 246.9,209.2 L 251.5,210.3 L 255.9,210.3 L 260.2,209.3 L 264.3,207.3 L 268.2,204.3 L 271.7,200.4 L 274.8,195.6 L 277.7,186.2 L 280.7,177.6 L 283.8,169.7 L 287.1,162.6 L 290.4,156.3 L 293.8,150.8 L 297.2,146.1 L 300.7,142.1 L 304.2,138.9 L 307.7,136.5 L 311.2,134.9 L 314.6,134.0 L 318.0,133.9 L 321.3,134.6 L 324.6,136.1 L 327.7,138.4 L 330.7,141.4 L 333.6,145.2 L 338.6,154.5 L 343.7,162.4 L 348.7,168.7 L 353.8,173.7 L 358.8,177.2 L 363.8,179.4 L 368.9,180.2 L 373.9,179.6 L 379.0,177.7 L 384.0,174.6 L 387.5,169.2 L 391.1,164.8 L 394.9,161.3 L 398.8,158.7 L 402.7,157.0 L 406.6,156.1 L 410.4,156.0 L 414.2,156.6 L 417.9,158.0 L 421.3,160.0 L 424.6,162.6 L 427.5,165.9 L 430.2,169.7 L 432.5,174.0 L 434.4,178.8 L 438.8,185.3 L 441.8,191.3 L 443.9,196.8 L 445.0,201.8 L 445.4,206.2 L 445.2,210.0 L 444.6,213.2 L 443.9,215.7 L 443.1,217.5 L 442.5,218.6 L 442.2,219.0 L 442.4,218.6 L 443.3,217.4 L 445.1,215.3 L 447.8,212.4 L 451.7,206.1 L 455.4,201.1 L 458.9,197.5 L 462.3,195.0 L 465.5,193.8 L 468.4,193.7 L 471.0,194.7 L 473.4,196.8 L 475.6,199.8 L 477.4,203.8 L 478.8,208.6 L 479.9,214.3 L 480.7,220.7 L 481.0,227.9 L 481.0,235.7 L 480.5,244.2 L 479.5,253.2 L 478.1,262.8 L 477.4,272.8 L 476.8,282.5 L 476.2,292.0 L 475.7,301.2 L 475.1,310.1 L 474.5,318.7 L 474.0,327.0 L 473.4,335.0 L 472.8,342.6 L 472.1,349.9 L 471.4,356.8 L 470.7,363.3 L 469.8,369.4 L 469.0,375.1 L 468.0,380.4 Z";

const EYES = [237, 363] as const;
const EYE_Y = 355.2;

/** The spirit mark alone. `size` is in px. `blinkOnHover`: the eyes blink while hovered
 * (a small easter egg on the sidebar logo; off under reduced motion / high contrast). */
export function RuahMark({
  className,
  size = 24,
  blinkOnHover = false,
}: {
  className?: string | undefined;
  size?: number;
  blinkOnHover?: boolean;
}) {
  return (
    <svg
      viewBox="0 0 600 600"
      width={size}
      height={size}
      aria-hidden="true"
      className={cn("shrink-0", blinkOnHover && "phantom-hoverblink", className)}
    >
      <path d={RUAH_BODY_PATH} style={{ fill: "var(--ph-brand)" }} />
      <g className="phantom-eyes">
        {EYES.map((cx) => (
          <ellipse key={cx} cx={cx} cy={EYE_Y} rx={24.4} ry={31.5} className="fill-warm-100" />
        ))}
      </g>
    </svg>
  );
}

const sizes = {
  sm: { icon: 22, text: "text-[17px]", gap: "gap-1.5" },
  md: { icon: 32, text: "text-xl", gap: "gap-2.5" },
  lg: { icon: 44, text: "text-2xl", gap: "gap-2.5" },
} as const;

/** Mark + wordmark, as in the website header. */
export function RuahLogo({
  size = "md",
  showText = true,
  blinkOnHover = false,
  className,
}: {
  size?: keyof typeof sizes;
  showText?: boolean;
  blinkOnHover?: boolean;
  className?: string | undefined;
}) {
  const s = sizes[size];
  return (
    <span className={cn("flex items-center", s.gap, className)}>
      <RuahMark size={s.icon} blinkOnHover={blinkOnHover} />
      {showText ? (
        <span className={cn("font-brand font-medium tracking-wide text-foreground", s.text)}>ruah</span>
      ) : null}
    </span>
  );
}
