// The Phantom family beyond the eight expressions (Phantom.tsx):
//   <PhantomPose pose="sleeping" />       one of 19 poses (phantom-figures.tsx), tone per role
//   <PhantomAgent agent="claude" />       a coding agent's own ghost: its tint + a small emblem
//   <PhantomScene scene="trio" />         duo / trio / handoff / party / crew group scenes for
//                                         onboarding and empty states
// Same rules as Phantom: SVG + CSS-only motion (phantom.css), per-instance phase, static under
// reduced motion and in high contrast, paused while the tab is hidden; decorative unless a
// `label` is given.
import { useEffect, useId, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import type { AgentTint } from "@/design/tokens";
import {
  EXPRESSION_CONFIG,
  PHANTOM_SIZES,
  canonicalTone,
  eyeScale,
  hookVisibility,
  phaseOf,
  type PhantomExpression,
  type PhantomSize,
  type PhantomTone,
} from "./Phantom";
import { Figure, POSES, type PhantomPoseName } from "./phantom-figures";

export { POSES, POSE_NAMES, type PhantomPoseName } from "./phantom-figures";

const px = (size: PhantomSize | number) => (typeof size === "number" ? size : PHANTOM_SIZES[size]);

interface Common {
  /** xs 16 · sm 24 · md 40 · lg 72 · xl 120, or px. Poses read best from md up. */
  size?: PhantomSize | number | undefined;
  tone?: PhantomTone | undefined;
  /** No motion at all. */
  still?: boolean | undefined;
  /** No idle drift (on by default from md up). */
  noFloat?: boolean | undefined;
  /** No ambient glow (on by default from lg up). */
  noGlow?: boolean | undefined;
  /** When the ghost carries meaning, its label (role="img"); otherwise decorative. */
  label?: string | undefined;
  className?: string | undefined;
  style?: CSSProperties | undefined;
}

function Shell({
  size,
  tone,
  still,
  noFloat,
  noGlow,
  label,
  className,
  style,
  expression,
  pose,
  children,
}: Common & { size: number; tone: string; expression?: string; pose?: string; children: React.ReactNode }) {
  const id = useId();
  useEffect(hookVisibility, []);
  const float = !still && !noFloat && size >= 40;
  const glow = !noGlow && size >= 72;
  const vars = { width: size, height: size, "--ph-delay": `-${phaseOf(id).toFixed(2)}s`, ...style } as CSSProperties;
  return (
    <span
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      data-tone={tone}
      data-expression={expression}
      data-pose={pose}
      data-still={still ? "" : undefined}
      className={cn("phantom", className)}
      style={vars}
    >
      {glow ? <span aria-hidden className="phantom-glow" /> : null}
      <span className={cn("phantom-drift", float && "phantom-float")}>
        <svg viewBox="0 0 600 600" width={size} height={size} aria-hidden="true" className="phantom-body">
          {children}
        </svg>
      </span>
    </span>
  );
}

export interface PhantomPoseProps extends Common {
  pose: PhantomPoseName;
}

/** One of the Phantom's poses (sleeping, reading, terminal, detective, …). */
export function PhantomPose({ pose, size = "lg", tone, label, ...rest }: PhantomPoseProps) {
  return (
    <Shell size={px(size)} tone={tone ? canonicalTone(tone) : POSES[pose].tone} pose={pose} label={label} {...rest}>
      <Figure pose={pose} />
    </Shell>
  );
}

const AGENT_ALIASES: Record<string, AgentTint> = {
  claude: "claude",
  "claude-code": "claude",
  "claude-acp": "claude",
  acp: "claude",
  cursor: "cursor",
  "cursor-agent": "cursor",
  grok: "grok",
  "grok-build": "grok",
  kiro: "kiro",
  "kiro-cli": "kiro",
  opencode: "opencode",
  "open-code": "opencode",
};

/** The agent tint for a daemon agent id (claude, claude-acp, cursor, grok, kiro, opencode, …). */
export function agentTintOf(agentId: string | undefined | null): AgentTint | undefined {
  if (!agentId) return undefined;
  return AGENT_ALIASES[agentId.toLowerCase()];
}

export interface PhantomAgentProps extends Common {
  /** A daemon agent id (claude, cursor, grok, kiro, opencode, claude-acp, …). Unknown ids get
   * the palette's AI ghost. */
  agent: string;
  expression?: PhantomExpression | undefined;
  /** Draw the emblem (default: from 32 px, where it reads). */
  emblem?: boolean | undefined;
}

/** A coding agent's own ghost: the agent's tint, the expression's eyes and a small emblem. */
export function PhantomAgent({ agent, expression = "idle", emblem, size = "md", tone, label, ...rest }: PhantomAgentProps) {
  const tint = agentTintOf(agent);
  const s = px(size);
  const cfg = EXPRESSION_CONFIG[expression];
  const showEmblem = !!tint && (emblem ?? s >= 32) && (expression === "idle" || expression === "agent" || expression === "tracking");
  return (
    <Shell size={s} tone={tone ? canonicalTone(tone) : (tint ?? "ai")} expression={expression} label={label} {...rest}>
      <Figure eyes={cfg.eye} agent={showEmblem ? tint : undefined} {...eyeScale(s)} />
    </Shell>
  );
}

// ---- group scenes ------------------------------------------------------------------------------

export type PhantomSceneName = "duo" | "trio" | "handoff" | "party" | "crew";

interface Cast {
  pose?: PhantomPoseName;
  agent?: AgentTint;
  tone?: PhantomTone;
  x: number;
  y: number;
  s: number;
  /** Mirror (faces left). */
  flip?: boolean;
}

const SCENES: Record<PhantomSceneName, { w: number; h: number; role: string; cast: Cast[] }> = {
  duo: {
    w: 1060,
    h: 600,
    role: "You and your agent",
    cast: [
      { pose: "waving", tone: "brand", x: 0, y: 0, s: 1 },
      { pose: "reading", tone: "ai", x: 470, y: 20, s: 0.96 },
    ],
  },
  trio: {
    w: 1480,
    h: 620,
    role: "Agents working in parallel",
    cast: [
      { pose: "building", tone: "ai", x: 0, y: 44, s: 0.92 },
      { pose: "terminal", tone: "brand", x: 440, y: 0, s: 1 },
      { pose: "checklist", tone: "ok", x: 900, y: 44, s: 0.92 },
    ],
  },
  handoff: {
    w: 1060,
    h: 600,
    role: "An agent hands work back for review",
    cast: [
      { pose: "building", tone: "ai", x: 0, y: 12, s: 0.97 },
      { pose: "reading", tone: "brand", x: 470, y: 0, s: 1 },
    ],
  },
  party: {
    w: 1480,
    h: 620,
    role: "Everything done",
    cast: [
      { pose: "celebrating", tone: "ai", x: 0, y: 44, s: 0.9 },
      { pose: "celebrating", tone: "brand", x: 440, y: 0, s: 1 },
      { pose: "celebrating", tone: "ok", x: 900, y: 44, s: 0.9 },
    ],
  },
  crew: {
    w: 1960,
    h: 560,
    role: "Claude Code, Cursor, Grok, Kiro and OpenCode",
    cast: [
      { agent: "claude", x: 0, y: 20, s: 0.88 },
      { agent: "cursor", x: 340, y: 0, s: 0.92 },
      { agent: "grok", x: 690, y: 30, s: 0.86 },
      { agent: "kiro", x: 1020, y: 0, s: 0.92 },
      { agent: "opencode", x: 1370, y: 24, s: 0.88 },
    ],
  },
};

export const SCENE_NAMES = Object.keys(SCENES) as PhantomSceneName[];
export const sceneRole = (scene: PhantomSceneName) => SCENES[scene].role;

export interface PhantomSceneProps {
  scene: PhantomSceneName;
  /** Height in px (the width follows the scene). */
  height?: number;
  still?: boolean | undefined;
  label?: string | undefined;
  className?: string | undefined;
}

/** Several ghosts in one drawing (onboarding, empty states). Each figure floats on its own
 * phase; tones follow the palette, the crew uses the agents' tints. */
export function PhantomScene({ scene, height = 120, still, label, className }: PhantomSceneProps) {
  const id = useId();
  useEffect(hookVisibility, []);
  const spec = SCENES[scene];
  const width = Math.round((height * spec.w) / spec.h);
  const base = phaseOf(id);
  return (
    <span
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      data-still={still ? "" : undefined}
      data-scene={scene}
      className={cn("phantom phantom-scene", className)}
      style={{ width, height, "--ph-delay": `-${base.toFixed(2)}s` } as CSSProperties}
    >
      <svg viewBox={`0 0 ${spec.w} ${spec.h}`} width={width} height={height} aria-hidden="true" className="phantom-body">
        {spec.cast.map((c, i) => {
          const tone = c.tone ? canonicalTone(c.tone) : (c.agent ?? (c.pose ? POSES[c.pose].tone : "brand"));
          const flip = c.flip ? ` translate(600 0) scale(-1 1)` : "";
          return (
            <g key={i} transform={`translate(${c.x} ${c.y}) scale(${c.s})${flip}`}>
              <g
                className={cn("phantom-figure", !still && "phantom-float")}
                data-tone={tone}
                style={{ "--ph-delay": `-${((base + i * 1.7) % 6).toFixed(2)}s` } as CSSProperties}
              >
                <Figure pose={c.pose} agent={c.agent} eyes="round" />
              </g>
            </g>
          );
        })}
      </svg>
    </span>
  );
}

/** Default expression tone, for callers that tint surrounding UI to match a ghost. */
export const expressionTone = (e: PhantomExpression) => EXPRESSION_CONFIG[e].tone;
