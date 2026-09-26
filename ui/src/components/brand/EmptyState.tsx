// A page state with a Phantom: empty lists, first runs, loading and failures. One component so
// every page speaks the same way — a ghost on a soft tone disc (solid, no gradient, as the design
// system asks), an optional eyebrow in the tone's colour, a title, one or two sentences and the
// actions. The ghost is decorative; the text carries the meaning (and `live` announces it).
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Phantom, canonicalTone, toneVar, type PhantomExpression, type PhantomTone } from "./Phantom";
import { POSES, PhantomPose, PhantomScene, type PhantomPoseName, type PhantomSceneName } from "./PhantomPose";

export interface EmptyStateProps {
  /** The ghost: a pose, an expression, a group scene, or your own art. */
  pose?: PhantomPoseName | undefined;
  expression?: PhantomExpression | undefined;
  scene?: PhantomSceneName | undefined;
  art?: ReactNode;
  /** Ghost + disc + eyebrow colour (defaults to the pose's / expression's). */
  tone?: PhantomTone | undefined;
  eyebrow?: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  actions?: ReactNode;
  /** sm: inside panels · md: a page body · lg: onboarding / first run. */
  size?: "sm" | "md" | "lg";
  /** Announce changes (loading → failed) to assistive tech. */
  live?: "polite" | "assertive" | undefined;
  /** Keep the pose / scene props moving (a state that reports progress). Default: they move on
   * hover only, so a page full of empty states costs no paint while idle. */
  lively?: boolean | undefined;
  className?: string | undefined;
  children?: ReactNode;
}

const TEXT: Record<string, string> = {
  brand: "text-brand",
  ai: "text-ai",
  ok: "text-ok",
  warn: "text-warn",
  bad: "text-bad",
  info: "text-info",
};

const SIZES = {
  sm: { ghost: 56, disc: "size-20", title: "text-title-sm", body: "text-ui-sm", gap: "gap-1.5", pad: "py-8", scene: 64 },
  md: { ghost: 88, disc: "size-28", title: "text-headline", body: "text-ui", gap: "gap-2", pad: "py-16", scene: 96 },
  lg: { ghost: 120, disc: "size-40", title: "text-display", body: "text-body", gap: "gap-2.5", pad: "py-20", scene: 132 },
} as const;

export function EmptyState({
  pose,
  expression,
  scene,
  art,
  tone,
  eyebrow,
  title,
  body,
  actions,
  size = "md",
  live,
  lively,
  className,
  children,
}: EmptyStateProps) {
  const s = SIZES[size];
  const resolved = tone ? canonicalTone(tone) : pose ? POSES[pose].tone : expression === "error" ? "bad" : expression === "warning" ? "warn" : expression === "success" ? "ok" : expression === "agent" || expression === "thinking" ? "ai" : "brand";
  const ghost = art ?? (scene ? (
    <PhantomScene scene={scene} height={s.scene} lively={lively} />
  ) : pose ? (
    <PhantomPose pose={pose} size={s.ghost} tone={tone} noGlow lively={lively} />
  ) : (
    <Phantom expression={expression ?? "idle"} size={Math.round(s.ghost * 0.7)} tone={tone} noGlow />
  ));
  return (
    <div
      className={cn("flex flex-col items-center justify-center text-center", s.pad, s.gap, className)}
      {...(live ? { role: live === "assertive" ? "alert" : "status", "aria-live": live } : {})}
    >
      <div className="relative mb-2 grid place-items-center">
        {scene || art ? null : (
          <span
            aria-hidden
            className={cn("absolute rounded-full", s.disc)}
            style={{ background: `color-mix(in oklab, var(${toneVar(resolved)}) 13%, transparent)` }}
          />
        )}
        <span className="relative">{ghost}</span>
      </div>
      {eyebrow ? (
        <p className={cn("text-caption font-medium tracking-[0.14em] uppercase", TEXT[resolved] ?? "text-faint")}>{eyebrow}</p>
      ) : null}
      <p className={cn("heading text-foreground", s.title)}>{title}</p>
      {body ? <div className={cn("max-w-md leading-relaxed text-muted-foreground", s.body)}>{body}</div> : null}
      {children}
      {actions ? <div className="mt-3 flex flex-wrap items-center justify-center gap-2">{actions}</div> : null}
    </div>
  );
}
