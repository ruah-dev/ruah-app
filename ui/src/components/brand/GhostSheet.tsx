// Dev-only expression sheet for the Phantom mascot (route /_ghosts, not in the nav): every
// expression × size, in the three themes side by side, plus eye shapes, tones and the
// cursor-tracking companion.
import {
  PHANTOM_EXPRESSIONS,
  PHANTOM_SIZES,
  Phantom,
  PhantomCompanion,
  type EyeShape,
  type PhantomSize,
  type PhantomTone,
} from "./Phantom";

const THEMES = [
  { id: "dark", label: "Dark", bg: "#20201e", fg: "#f0eee9", sub: "#b8b3a8", line: "#3a3a37" },
  { id: "light", label: "Light", bg: "#faf9f7", fg: "#1a1a19", sub: "#565248", line: "#e0dcd4" },
  { id: "contrast", label: "High contrast (static)", bg: "#000000", fg: "#ffffff", sub: "#d0d0d0", line: "#5a5a5a" },
] as const;

const SIZES = Object.keys(PHANTOM_SIZES) as PhantomSize[];
const EYES: EyeShape[] = ["round", "arc", "line", "squint", "sparkle", "cross"];
const TONES: PhantomTone[] = ["teal", "lavender", "sage", "amber", "coral", "muted"];

export function GhostSheet() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[88rem] flex-col gap-6 px-6 py-6">
        <div className="flex items-center gap-4">
          <PhantomCompanion size="md" />
          <div>
            <h1 className="heading text-title text-foreground">Phantom · expression sheet</h1>
            <p className="text-ui-sm text-muted-foreground">
              8 expressions × 5 sizes (xs 16 · sm 24 · md 40 · lg 72 · xl 120) in each theme. Dev route, not in the nav.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-4 max-xl:grid-cols-1">
          {THEMES.map((t) => (
            <section
              key={t.id}
              data-ph-theme={t.id}
              className="rounded-xl p-4"
              style={{ background: t.bg, color: t.fg, boxShadow: `inset 0 0 0 1px ${t.line}` }}
            >
              <h2 className="mb-3 text-ui font-medium">{t.label}</h2>
              <table className="w-full border-separate border-spacing-y-1.5 text-meta">
                <thead>
                  <tr style={{ color: t.sub }}>
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
                      <td className="pe-2 font-mono" style={{ color: t.sub }}>
                        {e}
                      </td>
                      {SIZES.map((s) => (
                        <td key={s} className="text-center align-middle">
                          {e === "tracking" && s === "xl" ? (
                            <PhantomCompanion size={s} />
                          ) : (
                            <Phantom expression={e} size={s} />
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-4 flex flex-wrap items-end gap-3" style={{ borderTop: `1px solid ${t.line}`, paddingTop: 12 }}>
                {EYES.map((eye) => (
                  <figure key={eye} className="flex flex-col items-center gap-1">
                    <Phantom expression="idle" eyes={eye} size="md" noFloat />
                    <figcaption className="font-mono text-[10px]" style={{ color: t.sub }}>
                      {eye}
                    </figcaption>
                  </figure>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap items-end gap-3">
                {TONES.map((tone) => (
                  <figure key={tone} className="flex flex-col items-center gap-1">
                    <Phantom expression="idle" tone={tone} size="sm" />
                    <figcaption className="font-mono text-[10px]" style={{ color: t.sub }}>
                      {tone}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
