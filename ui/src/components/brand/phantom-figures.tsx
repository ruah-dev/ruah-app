// The Phantom family's poses: the design system's #phantom-body silhouette (RUAH_BODY_PATH, the
// same 600 × 600 box as Phantom.tsx) with a face and props drawn in its flat style — solid
// fills, round caps, no outlines or gradients. Every colour is a token (phantom.css): the body
// is --ph-body (the tone), props use --ph-paper / --ph-ink / --ph-prop / --ph-prop-deep /
// --ph-screen and the palette's role colours, so a pose follows palette × theme.
// Motion is CSS only (phantom.css, "ph-*" classes): transforms and opacity, phase-shifted per
// instance, off under reduced motion and in high contrast.
//
// A figure is an SVG <g> in 600-unit space, so the same drawing serves a single ghost
// (PhantomPose) and a group scene (PhantomScene).
import type { CSSProperties, ReactNode } from "react";
import { RUAH_BODY_PATH } from "@/components/brand/RuahLogo";
import type { AgentTint } from "@/design/tokens";
import { EYES_X, EYE_Y, Eye, type EyeShape } from "./Phantom";

export type PhantomPoseName =
  | "sleeping"
  | "celebrating"
  | "reading"
  | "building"
  | "searching"
  | "cloud"
  | "infra"
  | "terminal"
  | "detective"
  | "traveler"
  | "keyholder"
  | "headset"
  | "waving"
  | "charting"
  | "plugging"
  | "painting"
  | "checklist"
  | "chatting"
  | "mapping";

type Pt = readonly [number, number];
const d = (s: number): CSSProperties => ({ "--d": `${s}s` }) as CSSProperties;
const origin = (x: number, y: number): CSSProperties => ({ transformOrigin: `${x}px ${y}px` });

/** The body, optionally moved (lean, shift) around its base. */
function Body({ transform, className }: { transform?: string; className?: string }) {
  return <path d={RUAH_BODY_PATH} className={className ? `phantom-skin ${className}` : "phantom-skin"} transform={transform} />;
}

/** A stubby arm: a round-capped stroke in the body colour. */
function Arm({ from, to, w = 46, className, style }: { from: Pt; to: Pt; w?: number; className?: string; style?: CSSProperties }) {
  return (
    <line
      x1={from[0]}
      y1={from[1]}
      x2={to[0]}
      y2={to[1]}
      strokeWidth={w}
      strokeLinecap="round"
      className={className ? `phantom-limb ${className}` : "phantom-limb"}
      style={style}
    />
  );
}

// ---- faces -------------------------------------------------------------------------------------

/** Round eyes; `look` moves pupils (none when undefined), `lid` flattens them (0…1). */
function RoundEyes({ look, dx = 0, dy = 0, scale = 1, shine = false }: { look?: Pt; dx?: number; dy?: number; scale?: number; shine?: boolean }) {
  return (
    <g className="phantom-eyes">
      {EYES_X.map((cx) => (
        <g key={cx}>
          <ellipse cx={cx + dx} cy={EYE_Y + dy} rx={24.4 * scale} ry={31.5 * scale} className="phantom-fill" />
          {look ? <circle cx={cx + dx + look[0]} cy={EYE_Y + dy + look[1]} r={10 * scale} className="phantom-pupil" /> : null}
          {shine ? <circle cx={cx + dx - 8} cy={EYE_Y + dy - 12} r={6.5} className="phantom-shine" /> : null}
        </g>
      ))}
    </g>
  );
}

/** Happy "^ ^" eyes. */
function HappyEyes({ dx = 0, dy = 0 }: { dx?: number; dy?: number }) {
  return (
    <g className="phantom-eyes">
      {EYES_X.map((cx) => (
        <path
          key={cx}
          d={`M ${cx + dx - 25} ${EYE_Y + dy + 8} Q ${cx + dx} ${EYE_Y + dy - 26} ${cx + dx + 25} ${EYE_Y + dy + 8}`}
          className="phantom-stroke"
          strokeWidth={13}
          strokeLinecap="round"
          fill="none"
        />
      ))}
    </g>
  );
}

/** Closed, sleeping "‿ ‿" eyes. */
function ClosedEyes({ dx = 0, dy = 0 }: { dx?: number; dy?: number }) {
  return (
    <g>
      {EYES_X.map((cx) => (
        <path
          key={cx}
          d={`M ${cx + dx - 25} ${EYE_Y + dy - 4} Q ${cx + dx} ${EYE_Y + dy + 20} ${cx + dx + 25} ${EYE_Y + dy - 4}`}
          className="phantom-stroke"
          strokeWidth={12}
          strokeLinecap="round"
          fill="none"
        />
      ))}
    </g>
  );
}

/** Narrowed, focused eyes with pupils (the design system's Accountant). */
function SquintEyes({ look = [0, 0] }: { look?: Pt }) {
  return (
    <g className="phantom-eyes">
      {EYES_X.map((cx) => (
        <g key={cx}>
          <ellipse cx={cx} cy={EYE_Y + 4} rx={24} ry={12} className="phantom-fill" />
          <circle cx={cx + look[0]} cy={EYE_Y + 4 + look[1]} r={7} className="phantom-pupil" />
        </g>
      ))}
    </g>
  );
}

function Blush({ dx = 0, dy = 0 }: { dx?: number; dy?: number }) {
  return (
    <g className="ph-blush">
      <ellipse cx={206 + dx} cy={398 + dy} rx={19} ry={9} />
      <ellipse cx={394 + dx} cy={398 + dy} rx={19} ry={9} />
    </g>
  );
}

// ---- props -------------------------------------------------------------------------------------

function Sparkle({ x, y, r, className = "ph-paper-fill", style }: { x: number; y: number; r: number; className?: string; style?: CSSProperties }) {
  const k = r * 0.28;
  return (
    <path
      d={`M ${x} ${y - r} Q ${x + k} ${y - k} ${x + r} ${y} Q ${x + k} ${y + k} ${x} ${y + r} Q ${x - k} ${y + k} ${x - r} ${y} Q ${x - k} ${y - k} ${x} ${y - r} Z`}
      className={`ph-twinkle ${className}`}
      style={style}
    />
  );
}

function Magnifier({ at, r, handleTo, lens = true }: { at: Pt; r: number; handleTo: Pt; lens?: boolean }) {
  const [x, y] = at;
  const ang = Math.atan2(handleTo[1] - y, handleTo[0] - x);
  const hx = x + Math.cos(ang) * (r + 6);
  const hy = y + Math.sin(ang) * (r + 6);
  return (
    <g>
      <line x1={hx} y1={hy} x2={handleTo[0]} y2={handleTo[1]} strokeWidth={24} strokeLinecap="round" className="ph-deep-stroke" />
      {lens ? <circle cx={x} cy={y} r={r} className="ph-glass" /> : null}
      <circle cx={x} cy={y} r={r} strokeWidth={15} fill="none" className="ph-prop-stroke" />
      <path d={`M ${x - r * 0.62} ${y - r * 0.2} A ${r * 0.66} ${r * 0.66} 0 0 1 ${x - r * 0.2} ${y - r * 0.62}`} strokeWidth={8} strokeLinecap="round" fill="none" className="ph-paper-stroke" opacity={0.85} />
    </g>
  );
}

/** A little bug (debugging). */
function Bug({ x, y }: { x: number; y: number }) {
  return (
    <g className="ph-crawl">
      {[-12, 0, 12].map((o) => (
        <g key={o} className="ph-deep-stroke" strokeWidth={5} strokeLinecap="round">
          <line x1={x + o} y1={y} x2={x + o - 6} y2={y - 24} />
          <line x1={x + o} y1={y} x2={x + o - 6} y2={y + 24} />
        </g>
      ))}
      <ellipse cx={x} cy={y} rx={24} ry={17} className="ph-c-bad" />
      <circle cx={x + 26} cy={y} r={10} className="ph-c-bad" />
      <line x1={x} y1={y - 16} x2={x} y2={y + 16} strokeWidth={4} className="ph-deep-stroke" />
      <circle cx={x - 10} cy={y - 6} r={4} className="ph-deep-fill" />
      <circle cx={x + 9} cy={y + 6} r={4} className="ph-deep-fill" />
    </g>
  );
}

// ---- poses -------------------------------------------------------------------------------------

export interface PoseSpec {
  /** Default body tone. */
  tone: "brand" | "ai" | "ok" | "warn" | "bad" | "info";
  /** What the pose is for (sheet caption + a11y label default). */
  role: string;
  render: () => ReactNode;
}

const Zs = () => (
  <g className="ph-z-group" strokeLinecap="round" strokeLinejoin="round" fill="none">
    {(
      [
        [436, 214, 30, 0],
        [482, 150, 40, 1],
        [522, 74, 50, 2],
      ] as const
    ).map(([x, y, s, i]) => (
      <path key={i} d={`M ${x} ${y} h ${s} l ${-s} ${s} h ${s}`} strokeWidth={11} className="ph-z ph-skin-stroke" style={d(i * 1.1)} />
    ))}
  </g>
);

const CONFETTI: readonly (readonly [number, number, string, "r" | "c", number])[] = [
  [96, 150, "ph-c-brand", "r", 20],
  [150, 70, "ph-c-ai", "c", 0],
  [236, 40, "ph-c-warn", "r", -30],
  [372, 50, "ph-c-x2", "c", 0],
  [456, 88, "ph-c-ok", "r", 40],
  [528, 160, "ph-c-ai", "r", -15],
  [60, 250, "ph-c-x2", "c", 0],
  [548, 262, "ph-c-brand", "c", 0],
  [196, 120, "ph-c-x1", "r", 60],
  [410, 128, "ph-c-bad", "r", -50],
];

export const POSES: Record<PhantomPoseName, PoseSpec> = {
  sleeping: {
    tone: "info",
    role: "Nothing running — resting",
    render: () => (
      <>
        <g className="ph-breathe" transform="rotate(-6 300 462)">
          <Body />
          <ClosedEyes dy={6} />
          <Blush dy={10} />
        </g>
        <Zs />
      </>
    ),
  },
  celebrating: {
    tone: "ok",
    role: "Done — all merged",
    render: () => (
      <>
        <g className="ph-confetti-group">
          {CONFETTI.map(([x, y, c, shape, rot], i) =>
            shape === "r" ? (
              <rect key={i} x={x - 8} y={y - 14} width={16} height={28} rx={4} transform={`rotate(${rot} ${x} ${y})`} className={`ph-confetti ${c}`} style={d(i * 0.27)} />
            ) : (
              <circle key={i} cx={x} cy={y} r={10} className={`ph-confetti ${c}`} style={d(i * 0.27)} />
            ),
          )}
        </g>
        <g className="ph-hop">
          <Arm from={[180, 320]} to={[110, 222]} w={52} className="ph-cheer" style={origin(180, 320)} />
          <Arm from={[420, 320]} to={[490, 222]} w={52} className="ph-cheer ph-cheer-r" style={origin(420, 320)} />
          <Body />
          <HappyEyes />
          <Blush />
        </g>
      </>
    ),
  },
  reading: {
    tone: "brand",
    role: "Reading / scanning the repo",
    render: () => (
      <>
        <g className="ph-bob">
          <Body />
          <RoundEyes look={[0, 14]} dy={2} />
        </g>
        <g transform="rotate(-3 300 455)">
          <rect x={196} y={392} width={208} height={126} rx={14} className="ph-paper" />
          <line x1={220} y1={424} x2={318} y2={424} strokeWidth={9} strokeLinecap="round" className="ph-c-brand-stroke" />
          {[
            [448, 372],
            [470, 344],
            [492, 362],
          ].map(([y, x2]) => (
            <line key={y} x1={220} y1={y} x2={x2} y2={y} strokeWidth={8} strokeLinecap="round" className="ph-ink-stroke" opacity={0.55} />
          ))}
          <rect x={204} y={398} width={192} height={12} rx={6} className="ph-scanbar" />
        </g>
        <Arm from={[162, 400]} to={[214, 448]} w={44} />
        <Arm from={[438, 400]} to={[386, 448]} w={44} />
      </>
    ),
  },
  building: {
    tone: "ai",
    role: "An agent editing files",
    render: () => (
      <>
        <g className="ph-bob">
          <Body />
          <RoundEyes look={[-8, 13]} />
        </g>
        <g transform="rotate(-4 225 470)">
          <path d="M 150 404 a 12 12 0 0 1 12 -12 h 104 l 34 34 v 104 a 12 12 0 0 1 -12 12 h -126 a 12 12 0 0 1 -12 -12 Z" className="ph-paper" />
          <path d="M 266 392 v 22 a 12 12 0 0 0 12 12 h 22 Z" className="ph-prop-fill" opacity={0.55} />
          <line x1={172} y1={450} x2={250} y2={450} strokeWidth={9} strokeLinecap="round" className="ph-c-ai-stroke" />
          <line x1={172} y1={474} x2={276} y2={474} strokeWidth={9} strokeLinecap="round" className="ph-c-brand-stroke" />
          <line x1={172} y1={498} x2={246} y2={498} strokeWidth={9} strokeLinecap="round" className="ph-ink-stroke ph-write" style={origin(172, 498)} opacity={0.6} />
        </g>
        <g className="ph-scribble" style={origin(256, 500)}>
          <g transform="translate(256 500) rotate(38)">
            <rect x={-15} y={-132} width={30} height={112} rx={7} className="ph-c-warn" />
            <rect x={-15} y={-146} width={30} height={18} rx={3} className="ph-prop-fill" />
            <rect x={-15} y={-168} width={30} height={26} rx={9} className="ph-c-x2" />
            <path d="M -15 -22 L 15 -22 L 0 10 Z" className="ph-paper-fill" />
            <path d="M -5 -1 L 5 -1 L 0 10 Z" className="ph-ink-fill" />
          </g>
          <Arm from={[410, 396]} to={[334, 420]} w={42} />
        </g>
      </>
    ),
  },
  searching: {
    tone: "brand",
    role: "Searching",
    render: () => (
      <g className="ph-sway" style={origin(300, 470)}>
        <Body />
        <g className="phantom-eyes">
          <ellipse cx={237} cy={EYE_Y} rx={24.4} ry={31.5} className="phantom-fill" />
          <circle cx={247} cy={EYE_Y + 2} r={9} className="phantom-pupil" />
        </g>
        <ellipse cx={368} cy={352} rx={36} ry={46} className="phantom-fill" />
        <circle cx={382} cy={356} r={15} className="phantom-pupil" />
        <Magnifier at={[368, 352]} r={64} handleTo={[478, 478]} />
        <Arm from={[440, 420]} to={[470, 468]} w={44} />
      </g>
    ),
  },
  cloud: {
    tone: "brand",
    role: "Cloud resources",
    render: () => (
      <>
        <g className="ph-float-soft" transform="translate(0 -34)">
          <Body />
          <RoundEyes shine />
        </g>
        <g className="ph-drift">
          <g className="ph-cloud-shade" transform="translate(0 12)">
            <CloudShape />
          </g>
          <g className="ph-cloud">
            <CloudShape />
          </g>
        </g>
      </>
    ),
  },
  infra: {
    tone: "brand",
    role: "Infrastructure",
    render: () => (
      <>
        <g transform="translate(-52 6)">
          <Body />
          <RoundEyes look={[11, 2]} />
        </g>
        <g transform="translate(436 208)">
          <rect x={0} y={0} width={136} height={292} rx={18} className="ph-deep-fill" />
          {[0, 1, 2].map((i) => (
            <g key={i} transform={`translate(12 ${14 + i * 92})`}>
              <rect width={112} height={78} rx={11} className="ph-screen" />
              <line x1={16} y1={26} x2={62} y2={26} strokeWidth={7} strokeLinecap="round" className="ph-prop-stroke" opacity={0.55} />
              <line x1={16} y1={48} x2={50} y2={48} strokeWidth={7} strokeLinecap="round" className="ph-prop-stroke" opacity={0.55} />
              <circle cx={88} cy={26} r={8} className={`ph-led ${["ph-c-ok", "ph-c-brand", "ph-c-ok"][i]}`} style={d(i * 0.6)} />
              <circle cx={88} cy={50} r={8} className={`ph-led ${["ph-c-ai", "ph-c-warn", "ph-c-brand"][i]}`} style={d(0.3 + i * 0.5)} />
            </g>
          ))}
        </g>
        <Arm from={[390, 356]} to={[440, 326]} w={42} />
      </>
    ),
  },
  terminal: {
    tone: "brand",
    role: "Terminal",
    render: () => (
      <>
        <g className="ph-bob">
          <Body />
          <RoundEyes look={[0, 14]} dy={-2} />
        </g>
        <g>
          <rect x={172} y={378} width={256} height={160} rx={16} className="ph-screen" />
          <path d="M 172 410 v -16 a 16 16 0 0 1 16 -16 h 224 a 16 16 0 0 1 16 16 v 16 Z" className="ph-deep-fill" />
          <circle cx={196} cy={395} r={6} className="ph-c-bad" />
          <circle cx={216} cy={395} r={6} className="ph-c-warn" />
          <circle cx={236} cy={395} r={6} className="ph-c-ok" />
          <path d="M 196 432 L 212 444 L 196 456" strokeWidth={8} strokeLinecap="round" strokeLinejoin="round" fill="none" className="ph-c-ok-stroke" />
          <line x1={226} y1={444} x2={318} y2={444} strokeWidth={8} strokeLinecap="round" className="ph-paper-stroke" opacity={0.75} />
          <path d="M 196 474 L 212 486 L 196 498" strokeWidth={8} strokeLinecap="round" strokeLinejoin="round" fill="none" className="ph-c-ok-stroke" />
          <rect x={224} y={473} width={18} height={26} rx={3} className="ph-cursor ph-c-brand" />
        </g>
        <Arm from={[160, 400]} to={[180, 446]} w={40} />
        <Arm from={[440, 400]} to={[420, 446]} w={40} />
      </>
    ),
  },
  detective: {
    tone: "bad",
    role: "Debugging an error",
    render: () => (
      <>
        <Body />
        <g className="phantom-eyes">
          <ellipse cx={237} cy={EYE_Y + 6} rx={25} ry={11} className="phantom-fill" />
          <circle cx={243} cy={EYE_Y + 7} r={7} className="phantom-pupil" />
          <ellipse cx={363} cy={EYE_Y - 2} rx={27} ry={34} className="phantom-fill" />
          <circle cx={370} cy={EYE_Y + 8} r={11} className="phantom-pupil" />
        </g>
        <path d="M 208 326 L 264 336" strokeWidth={11} strokeLinecap="round" className="ph-brow" />
        <path d="M 336 300 Q 364 284 392 298" strokeWidth={11} strokeLinecap="round" fill="none" className="ph-brow ph-brow-raise" />
        <g transform="rotate(-9 300 206)">
          <path d="M 220 208 L 236 132 Q 300 112 364 132 L 380 208 Z" className="ph-deep-fill" />
          <path d="M 262 128 Q 300 146 338 128" strokeWidth={8} fill="none" strokeLinecap="round" className="ph-hat-dent" />
          <rect x={224} y={180} width={152} height={24} className="ph-prop-fill" />
          <ellipse cx={300} cy={208} rx={128} ry={21} className="ph-deep-fill" />
        </g>
        <Bug x={462} y={528} />
        <g className="ph-bob">
          <Magnifier at={[462, 518]} r={46} handleTo={[398, 450]} />
          <Arm from={[372, 428]} to={[398, 450]} w={40} />
        </g>
      </>
    ),
  },
  traveler: {
    tone: "brand",
    role: "Switching projects",
    render: () => (
      <>
        <g className="ph-speed-group" strokeLinecap="round">
          {(
            [
              [50, 290, 110],
              [30, 348, 118],
              [58, 406, 104],
            ] as const
          ).map(([x1, y, x2], i) => (
            <line key={y} x1={x1} y1={y} x2={x2} y2={y} strokeWidth={11} className="ph-speed ph-prop-stroke" style={d(i * 0.25)} />
          ))}
        </g>
        <g className="ph-bob" transform="rotate(7 300 462)">
          <Body />
          <RoundEyes look={[12, 0]} />
        </g>
        <g className="ph-swing" style={origin(462, 398)}>
          <path d="M 436 426 v -14 a 12 12 0 0 1 12 -12 h 28 a 12 12 0 0 1 12 12 v 14" strokeWidth={10} fill="none" className="ph-deep-stroke" />
          <rect x={402} y={424} width={122} height={96} rx={16} className="ph-c-x2" />
          <line x1={432} y1={428} x2={432} y2={516} strokeWidth={8} className="ph-deep-stroke" opacity={0.35} />
          <line x1={494} y1={428} x2={494} y2={516} strokeWidth={8} className="ph-deep-stroke" opacity={0.35} />
          <circle cx={463} cy={470} r={13} className="ph-paper-fill" />
        </g>
        <Arm from={[410, 360]} to={[458, 396]} w={40} />
      </>
    ),
  },
  keyholder: {
    tone: "brand",
    role: "Keys, secrets and extensions",
    render: () => (
      <>
        <g className="ph-key" style={origin(470, 300)}>
          <Arm from={[410, 350]} to={[478, 292]} w={44} />
          <g transform="translate(496 262) rotate(-62)">
            <line x1={32} y1={0} x2={150} y2={0} strokeWidth={17} strokeLinecap="round" className="ph-c-warn-stroke" />
            <rect x={104} y={4} width={13} height={30} rx={4} className="ph-c-warn" />
            <rect x={128} y={4} width={13} height={22} rx={4} className="ph-c-warn" />
            <circle cx={0} cy={0} r={32} strokeWidth={17} fill="none" className="ph-c-warn-stroke" />
          </g>
          <circle cx={484} cy={284} r={24} className="phantom-skin" />
        </g>
        <Body />
        <RoundEyes shine look={[10, -6]} />
        <Sparkle x={420} y={70} r={24} className="ph-c-warn" style={d(0)} />
        <Sparkle x={560} y={200} r={15} className="ph-c-warn" style={d(0.7)} />
      </>
    ),
  },
  headset: {
    tone: "brand",
    role: "Help",
    render: () => (
      <>
        <path d="M 142 336 C 136 110, 464 110, 458 336" strokeWidth={20} fill="none" className="ph-deep-stroke" />
        <Body />
        <HappyEyes />
        <Blush />
        <rect x={108} y={296} width={50} height={84} rx={20} className="ph-c-ai" />
        <rect x={442} y={296} width={50} height={84} rx={20} className="ph-c-ai" />
        <path d="M 136 374 Q 142 446 238 436" strokeWidth={10} fill="none" strokeLinecap="round" className="ph-deep-stroke" />
        <circle cx={246} cy={435} r={15} className="ph-c-ai" />
        <g className="ph-waves" fill="none" strokeLinecap="round">
          <path d="M 512 316 Q 530 338 512 360" strokeWidth={9} className="ph-wave ph-c-ai-stroke" style={d(0)} />
          <path d="M 532 296 Q 564 338 532 380" strokeWidth={9} className="ph-wave ph-c-ai-stroke" style={d(0.35)} />
        </g>
      </>
    ),
  },
  waving: {
    tone: "brand",
    role: "Hello",
    render: () => (
      <>
        <Arm from={[424, 332]} to={[500, 232]} className="ph-wave-arm" style={origin(424, 332)} />
        <g className="ph-bob">
          <Body />
          <HappyEyes />
          <Blush />
        </g>
      </>
    ),
  },
  charting: {
    tone: "warn",
    role: "Usage and cost",
    render: () => (
      <>
        <Body />
        <SquintEyes look={[0, 3]} />
        <rect x={188} y={384} width={224} height={142} rx={14} className="ph-paper" />
        {(
          [
            [212, 52, "ph-c-brand"],
            [258, 84, "ph-c-ai"],
            [304, 38, "ph-c-x1"],
            [350, 98, "ph-c-x2"],
          ] as const
        ).map(([x, h, c], i) => (
          <rect key={x} x={x} y={506 - h} width={34} height={h} rx={7} className={`ph-bar ${c}`} style={{ ...d(i * 0.18), ...origin(x + 17, 506) }} />
        ))}
        <line x1={204} y1={508} x2={396} y2={508} strokeWidth={5} strokeLinecap="round" className="ph-ink-stroke" opacity={0.45} />
        <Arm from={[164, 398]} to={[192, 440]} w={40} />
        <Arm from={[436, 398]} to={[408, 440]} w={40} />
      </>
    ),
  },
  plugging: {
    tone: "brand",
    role: "Integrations",
    render: () => (
      <>
        <path d="M 452 396 C 420 490, 262 474, 204 566" strokeWidth={12} fill="none" strokeLinecap="round" className="ph-deep-stroke" />
        <Body />
        <RoundEyes look={[12, 3]} />
        <g transform="translate(528 322)">
          <rect width={62} height={100} rx={16} className="ph-prop-fill" />
          <rect x={17} y={32} width={8} height={20} rx={3} className="ph-deep-fill" />
          <rect x={37} y={32} width={8} height={20} rx={3} className="ph-deep-fill" />
          <circle cx={31} cy={72} r={6} className="ph-deep-fill" />
        </g>
        <g className="ph-plug">
          <Arm from={[404, 382]} to={[452, 374]} w={42} />
          <rect x={446} y={350} width={54} height={50} rx={12} className="ph-deep-fill" />
          <rect x={498} y={356} width={30} height={9} rx={3} className="ph-prop-fill" />
          <rect x={498} y={384} width={30} height={9} rx={3} className="ph-prop-fill" />
          <circle cx={452} cy={374} r={23} className="phantom-skin" />
        </g>
        <Sparkle x={532} y={296} r={22} className="ph-c-warn ph-spark" style={d(0)} />
      </>
    ),
  },
  painting: {
    tone: "brand",
    role: "Appearance",
    render: () => (
      <>
        <Body />
        <RoundEyes shine look={[-10, 8]} />
        <path d="M 110 452 C 100 396, 190 372, 250 392 C 300 408, 296 446, 262 450 C 238 453, 244 478, 262 492 C 280 508, 240 532, 190 522 C 140 512, 116 488, 110 452 Z" className="ph-paper" />
        <circle cx={140} cy={444} r={14} className="ph-c-brand" />
        <circle cx={176} cy={414} r={14} className="ph-c-ai" />
        <circle cx={220} cy={410} r={13} className="ph-c-warn" />
        <circle cx={150} cy={486} r={13} className="ph-c-x2" />
        <circle cx={196} cy={500} r={12} className="ph-c-ok" />
        <Arm from={[180, 452]} to={[214, 458]} w={36} />
        <g className="ph-dab" style={origin(420, 404)}>
          <line x1={420} y1={404} x2={488} y2={306} strokeWidth={14} strokeLinecap="round" className="ph-deep-stroke" />
          <rect x={396} y={402} width={26} height={26} rx={5} transform="rotate(35 409 415)" className="ph-prop-fill" />
          <path d="M 380 446 Q 372 470 356 482 Q 384 486 404 458 Z" className="ph-c-ai" />
          <Arm from={[392, 372]} to={[432, 390]} w={40} />
        </g>
      </>
    ),
  },
  checklist: {
    tone: "brand",
    role: "Tasks",
    render: () => (
      <>
        <g className="ph-bob">
          <Body />
          <RoundEyes look={[0, 13]} dy={-2} />
        </g>
        <rect x={194} y={382} width={212} height={156} rx={16} className="ph-deep-fill" />
        <rect x={208} y={400} width={184} height={126} rx={9} className="ph-paper" />
        <rect x={266} y={368} width={68} height={28} rx={9} className="ph-prop-fill" />
        {[426, 460, 494].map((y, i) => (
          <g key={y}>
            <rect x={224} y={y - 11} width={22} height={22} rx={6} strokeWidth={4.5} fill="none" className="ph-ink-stroke" opacity={0.55} />
            <path d={`M 228 ${y} L 234 ${y + 6} L 246 ${y - 8}`} strokeWidth={7} strokeLinecap="round" strokeLinejoin="round" fill="none" className="ph-check ph-c-ok-stroke" style={d(i * 0.8)} />
            <line x1={260} y1={y} x2={[370, 346, 362][i]} y2={y} strokeWidth={8} strokeLinecap="round" className="ph-ink-stroke" opacity={0.5} />
          </g>
        ))}
        <Arm from={[168, 402]} to={[198, 442]} w={40} />
        <Arm from={[432, 402]} to={[402, 442]} w={40} />
      </>
    ),
  },
  chatting: {
    tone: "ai",
    role: "Chats",
    render: () => (
      <>
        <g transform="translate(-44 26) scale(0.94)">
          <Body />
          <RoundEyes look={[10, -8]} />
          <Blush />
        </g>
        <g className="ph-bubble" style={origin(420, 240)}>
          <path d="M 426 222 L 400 268 L 466 226 Z" className="ph-paper" />
          <rect x={376} y={100} width={196} height={130} rx={42} className="ph-paper" />
          {[428, 474, 520].map((x, i) => (
            <circle key={x} cx={x} cy={166} r={13} className="ph-typing ph-c-ai" style={d(i * 0.18)} />
          ))}
        </g>
      </>
    ),
  },
  mapping: {
    tone: "brand",
    role: "The architecture map",
    render: () => (
      <>
        <g className="ph-bob">
          <Body />
          <RoundEyes look={[0, 14]} dy={-2} />
        </g>
        <path d="M 186 400 L 256 386 L 256 516 L 186 530 Z" className="ph-paper" />
        <path d="M 256 386 L 344 404 L 344 534 L 256 516 Z" className="ph-paper ph-paper-shade" />
        <path d="M 344 404 L 414 390 L 414 520 L 344 534 Z" className="ph-paper" />
        <path d="M 204 498 C 236 446, 286 506, 322 458 S 372 432, 392 436" strokeWidth={7} strokeDasharray="12 11" strokeLinecap="round" fill="none" className="ph-c-ai-stroke" />
        <g className="ph-pin" style={origin(394, 438)}>
          <path d="M 394 440 C 372 412, 372 388, 394 386 C 416 388, 416 412, 394 440 Z" className="ph-c-bad" />
          <circle cx={394} cy={404} r={8} className="ph-paper-fill" />
        </g>
        <Arm from={[162, 404]} to={[190, 448]} w={40} />
        <Arm from={[438, 404]} to={[410, 448]} w={40} />
      </>
    ),
  },
};

function CloudShape() {
  return (
    <>
      <circle cx={172} cy={498} r={56} />
      <circle cx={244} cy={462} r={74} />
      <circle cx={336} cy={452} r={82} />
      <circle cx={424} cy={484} r={64} />
      <circle cx={478} cy={516} r={44} />
      <rect x={132} y={498} width={380} height={62} rx={31} />
    </>
  );
}

export const POSE_NAMES = Object.keys(POSES) as PhantomPoseName[];

// ---- agents' emblems ---------------------------------------------------------------------------

/** A small generic mark on each agent's ghost (never the vendor's artwork). */
export function AgentEmblem({ agent }: { agent: AgentTint }) {
  const cx = 300;
  const cy = 264;
  switch (agent) {
    case "claude":
      return (
        <g className="phantom-stroke" strokeWidth={10} strokeLinecap="round">
          {[0, 60, 120].map((a) => (
            <line key={a} x1={cx} y1={cy - 24} x2={cx} y2={cy + 24} transform={`rotate(${a} ${cx} ${cy})`} />
          ))}
        </g>
      );
    case "cursor":
      return <path d={`M ${cx - 14} ${cy - 26} L ${cx - 14} ${cy + 20} L ${cx - 2} ${cy + 8} L ${cx + 8} ${cy + 28} L ${cx + 17} ${cy + 24} L ${cx + 7} ${cy + 4} L ${cx + 22} ${cy + 4} Z`} className="phantom-fill" strokeLinejoin="round" />;
    case "grok":
      return <path d={`M ${cx + 8} ${cy - 28} L ${cx - 16} ${cy + 4} L ${cx - 1} ${cy + 4} L ${cx - 8} ${cy + 28} L ${cx + 17} ${cy - 6} L ${cx + 2} ${cy - 6} Z`} className="phantom-fill" />;
    case "kiro":
      return <Sparkle x={cx} y={cy} r={26} className="phantom-fill ph-static" />;
    case "opencode":
      return (
        <g className="phantom-stroke" strokeWidth={9} strokeLinecap="round" strokeLinejoin="round" fill="none">
          <path d={`M ${cx - 12} ${cy - 18} L ${cx - 28} ${cy} L ${cx - 12} ${cy + 18}`} />
          <path d={`M ${cx + 12} ${cy - 18} L ${cx + 28} ${cy} L ${cx + 12} ${cy + 18}`} />
        </g>
      );
  }
}

// ---- a whole figure ----------------------------------------------------------------------------

export interface FigureProps {
  /** A pose; without one the figure is the plain ghost with `eyes`. */
  pose?: PhantomPoseName | undefined;
  eyes?: EyeShape | undefined;
  agent?: AgentTint | undefined;
  /** Eye scale / stroke (small plain ghosts; poses draw their own faces). */
  k?: number;
  sw?: number;
}

/** The drawing of one ghost, in 600-unit space. Tone / motion come from the enclosing element
 * (data-tone, .phantom / .phantom-figure). */
export function Figure({ pose, eyes = "round", agent, k = 1, sw = 8 }: FigureProps) {
  if (pose) return <>{POSES[pose].render()}</>;
  return (
    <>
      <path d={RUAH_BODY_PATH} className="phantom-skin" />
      <g className="phantom-eyes">
        {EYES_X.map((cx) => (
          <Eye key={cx} cx={cx} shape={eyes} k={k} sw={sw} />
        ))}
      </g>
      {agent ? <AgentEmblem agent={agent} /> : null}
    </>
  );
}
