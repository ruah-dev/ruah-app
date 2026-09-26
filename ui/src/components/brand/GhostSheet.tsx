// Dev-only sheet for the Phantom family (route /_ghosts, not in the nav): every expression ×
// size, the 19 poses, the agents' ghosts, the group scenes and every tone — in the three
// themes side by side, for any palette (each column is a live data-ruah-preview scope, so it
// shows exactly what the app paints).
import { useState } from "react";
import * as RadioGroup from "@radix-ui/react-radio-group";
import { PALETTES, PALETTE_IDS, type PaletteId } from "@/design/tokens";
import { readPalette } from "@/lib/theme";
import { cn } from "@/lib/utils";
import {
  PHANTOM_EXPRESSIONS,
  PHANTOM_SIZES,
  Phantom,
  PhantomCompanion,
  SEMANTIC_TONES,
  type EyeShape,
  type PhantomSize,
} from "./Phantom";
import { POSES, POSE_NAMES, PhantomAgent, PhantomPose, PhantomScene, SCENE_NAMES, sceneRole } from "./PhantomPose";
import { EmptyState } from "./EmptyState";
import { AppearanceMenu } from "@/components/settings/AppearanceMenu";

const THEMES = [
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
  { id: "contrast", label: "High contrast (static)" },
] as const;

const SIZES = Object.keys(PHANTOM_SIZES) as PhantomSize[];
const EYES: EyeShape[] = ["round", "arc", "line", "squint", "sparkle", "cross"];
const AGENTS = ["claude", "cursor", "grok", "kiro", "opencode"] as const;
const AGENT_NAMES: Record<(typeof AGENTS)[number], string> = {
  claude: "Claude Code",
  cursor: "Cursor",
  grok: "Grok",
  kiro: "Kiro",
  opencode: "OpenCode",
};

type Section = "poses" | "expressions" | "agents" | "scenes" | "tones";

function Caption({ children }: { children: React.ReactNode }) {
  return <figcaption className="font-mono text-micro text-muted-foreground">{children}</figcaption>;
}

function Column({ theme, palette, section, poseSize }: { theme: (typeof THEMES)[number]; palette: PaletteId; section: Section; poseSize: number }) {
  return (
    <section
      data-ruah-preview={`${theme.id}:${palette}`}
      className="min-w-0 rounded-xl bg-background p-4 text-foreground ring-1 ring-hairline"
    >
      <h2 className="mb-3 text-ui font-medium">
        {theme.label} <span className="text-muted-foreground">· {PALETTES[palette].label}</span>
      </h2>
      {section === "poses" ? (
        <div className="grid gap-x-2 gap-y-4" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${poseSize + 16}px, 1fr))` }}>
          {POSE_NAMES.map((p) => (
            <figure key={p} className="flex flex-col items-center gap-1 text-center">
              <PhantomPose pose={p} size={poseSize} noGlow lively />
              <Caption>{p}</Caption>
              <span className="text-micro leading-tight text-faint">{POSES[p].role}</span>
            </figure>
          ))}
        </div>
      ) : null}
      {section === "expressions" ? (
        <>
          <table className="w-full border-separate border-spacing-y-1.5 text-meta">
            <thead>
              <tr className="text-muted-foreground">
                <th className="text-left font-normal">expression</th>
                {SIZES.map((s) => (
                  <th key={s} className="font-normal">
                    {s}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PHANTOM_EXPRESSIONS.map((e) => (
                <tr key={e}>
                  <td className="pe-2 font-mono text-muted-foreground">{e}</td>
                  {SIZES.map((s) => (
                    <td key={s} className="text-center align-middle">
                      {e === "tracking" && s === "xl" ? <PhantomCompanion size={s} /> : <Phantom expression={e} size={s} />}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-hairline pt-3">
            {EYES.map((eye) => (
              <figure key={eye} className="flex flex-col items-center gap-1">
                <Phantom expression="idle" eyes={eye} size="md" noFloat />
                <Caption>{eye}</Caption>
              </figure>
            ))}
          </div>
        </>
      ) : null}
      {section === "agents" ? (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-5 gap-2">
            {AGENTS.map((a) => (
              <figure key={a} className="flex flex-col items-center gap-1 text-center">
                <PhantomAgent agent={a} size={72} noGlow lively />
                <Caption>{AGENT_NAMES[a]}</Caption>
              </figure>
            ))}
          </div>
          {AGENTS.map((a) => (
            <div key={a} className="flex items-center gap-2">
              <span className="w-20 shrink-0 font-mono text-micro text-muted-foreground">{a}</span>
              {PHANTOM_EXPRESSIONS.filter((e) => e !== "tracking").map((e) => (
                <PhantomAgent key={e} agent={a} expression={e} size="sm" />
              ))}
              <PhantomAgent agent={a} size="xs" />
              <span className={cn("ms-auto size-3 rounded-full")} style={{ background: `var(--agent-${a})` }} />
            </div>
          ))}
        </div>
      ) : null}
      {section === "scenes" ? (
        <div className="flex flex-col gap-5">
          {SCENE_NAMES.map((s) => (
            <figure key={s} className="flex flex-col items-center gap-1">
              <PhantomScene scene={s} height={110} lively />
              <Caption>
                {s} · {sceneRole(s)}
              </Caption>
            </figure>
          ))}
          <div className="rounded-lg bg-surface-1 ring-1 ring-hairline">
            <EmptyState size="sm" pose="sleeping" eyebrow="Tasks" title="Nothing running" body="An EmptyState with a pose: tone disc, eyebrow, title, body." />
          </div>
        </div>
      ) : null}
      {section === "tones" ? (
        <div className="grid grid-cols-4 gap-3">
          {SEMANTIC_TONES.map((t) => (
            <figure key={t} className="flex flex-col items-center gap-1">
              <Phantom expression="idle" tone={t} size="md" noFloat />
              <Caption>{t}</Caption>
            </figure>
          ))}
        </div>
      ) : null}
    </section>
  );
}

const SECTIONS: { id: Section; label: string }[] = [
  { id: "poses", label: "Poses (19)" },
  { id: "expressions", label: "Expressions (8)" },
  { id: "agents", label: "Agents (5)" },
  { id: "scenes", label: "Scenes (5)" },
  { id: "tones", label: "Tones" },
];

/** ?palette=dusk&section=agents&size=200&theme=light make a view linkable. */
function param<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  if (typeof window === "undefined") return fallback;
  const v = new URLSearchParams(window.location.search).get(name);
  return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

export function GhostSheet() {
  const [palette, setPalette] = useState<PaletteId>(() => param("palette", PALETTE_IDS, typeof window === "undefined" ? "teal" : readPalette()));
  const [section, setSection] = useState<Section>(() => param("section", SECTIONS.map((s) => s.id), "poses"));
  const [poseSize, setPoseSize] = useState(() => Number(param("size", ["72", "96", "144", "200"], "96")));
  const [columns, setColumns] = useState<"all" | "dark" | "light" | "contrast">(() => param("theme", ["all", "dark", "light", "contrast"] as const, "all"));
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[96rem] flex-col gap-5 px-6 py-6">
        <div className="flex flex-wrap items-center gap-4">
          <PhantomCompanion size="md" />
          <div className="min-w-0 flex-1">
            <h1 className="heading text-title text-foreground">Phantom family</h1>
            <p className="text-ui-sm text-muted-foreground">
              19 poses · 8 expressions × 5 sizes · 5 agents · 5 scenes, in each theme of the chosen palette. Dev route, not in the nav.
            </p>
          </div>
          <AppearanceMenu />
          <RadioGroup.Root
            aria-label="Sheet palette"
            value={palette}
            onValueChange={(v) => setPalette(v as PaletteId)}
            className="flex flex-wrap gap-1"
          >
            {PALETTE_IDS.map((p) => (
              <RadioGroup.Item
                key={p}
                value={p}
                className={cn(
                  "h-7 rounded-lg px-2.5 text-ui-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  palette === p ? "bg-surface-3 text-foreground ring-1 ring-hairline" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {PALETTES[p].label}
              </RadioGroup.Item>
            ))}
          </RadioGroup.Root>
        </div>
        <div role="tablist" aria-label="Section" className="flex flex-wrap gap-1 border-b border-hairline pb-2">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={section === s.id}
              onClick={() => setSection(s.id)}
              className={cn(
                "h-7 rounded-md px-2.5 text-ui-sm transition-colors",
                section === s.id ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {s.label}
            </button>
          ))}
          <span className="ms-auto flex items-center gap-1 text-label text-muted-foreground">
            Pose size
            {[72, 96, 144, 200].map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={poseSize === n}
                onClick={() => setPoseSize(n)}
                className={cn("h-7 rounded-md px-2 tabular-nums", poseSize === n ? "bg-surface-3 text-foreground" : "hover:bg-accent")}
              >
                {n}
              </button>
            ))}
            <span className="ms-2">Themes</span>
            {(["all", "dark", "light", "contrast"] as const).map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={columns === c}
                onClick={() => setColumns(c)}
                className={cn("h-7 rounded-md px-2", columns === c ? "bg-surface-3 text-foreground" : "hover:bg-accent")}
              >
                {c}
              </button>
            ))}
          </span>
        </div>
        <div className={cn("grid gap-4", columns === "all" ? "grid-cols-3 max-xl:grid-cols-1" : "grid-cols-1")}>
          {THEMES.filter((t) => columns === "all" || t.id === columns).map((t) => (
            <Column key={t.id} theme={t} palette={palette} section={section} poseSize={poseSize} />
          ))}
        </div>
      </div>
    </div>
  );
}
