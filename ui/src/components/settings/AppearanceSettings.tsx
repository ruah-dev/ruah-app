// Settings → Appearance: theme, and the palette as live previews. Each palette card is a small
// mock of the app rendered inside a data-ruah-preview="<theme>:<palette>" scope (design/css.ts),
// so it shows exactly the tokens the app would use — surfaces, the primary action, the agent
// colour, statuses, chart series and the Phantoms — in the theme currently in effect.
// Self-contained: it reads and writes the same stores as the rest of the app (lib/theme.ts). The
// palette cards are an ARIA radio group (Radix): one Tab stop, arrow keys move and choose.
import { useEffect, useState, type ReactNode } from "react";
import * as RadioGroup from "@radix-ui/react-radio-group";
import { Check } from "lucide-react";
import { PALETTES, PALETTE_IDS, type PaletteId, type ThemeId } from "@/design/tokens";
import { usePalette, usePaletteNotice, useTheme, type ThemePref } from "@/lib/theme";
import { Button } from "@/components/ui/button";
import { Phantom } from "@/components/brand/Phantom";
import { PhantomPose } from "@/components/brand/PhantomPose";
import { Segmented } from "@/components/map/MapPage";
import { cn } from "@/lib/utils";

/** The theme in effect (html[data-theme]), following "system". */
export function useResolvedTheme(): ThemeId {
  const [theme, setTheme] = useState<ThemeId>("dark");
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => {
      const t = root.dataset["theme"];
      setTheme(t === "light" || t === "contrast" ? t : "dark");
    };
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);
  return theme;
}

/** A miniature of the app in one palette × theme. Decorative: the card's label names it. */
export function PalettePreview({ palette, theme, className }: { palette: PaletteId; theme: ThemeId; className?: string }) {
  return (
    <div
      aria-hidden
      data-ruah-preview={`${theme}:${palette}`}
      className={cn("pointer-events-none flex h-36 overflow-hidden rounded-lg bg-background text-foreground ring-1 ring-hairline select-none", className)}
    >
      <div className="flex w-14 shrink-0 flex-col gap-1.5 bg-surface-0 px-1.5 py-2">
        <span className="flex items-center gap-1">
          <Phantom expression="idle" size={10} still />
          <span className="h-1 w-5 rounded-full bg-foreground/40" />
        </span>
        <span className="mt-1 flex items-center gap-1 rounded-[3px] bg-accent px-1 py-0.5">
          <span className="h-2.5 w-0.5 rounded-full bg-primary" />
          <span className="h-1 w-6 rounded-full bg-foreground/70" />
        </span>
        {[7, 5, 8].map((w, i) => (
          <span key={i} className="flex items-center gap-1 px-1 py-0.5">
            <span className="h-1 rounded-full bg-muted-foreground/60" style={{ width: w * 4 }} />
          </span>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-2.5">
        <div className="flex items-center gap-1.5">
          <span className="h-1.5 w-12 rounded-full bg-foreground/80" />
          <span className="ms-auto rounded-[4px] bg-primary px-1.5 py-0.5 text-[7.5px] leading-none font-semibold text-primary-foreground">
            Run
          </span>
        </div>
        <div className="flex min-h-0 flex-1 gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 rounded-md bg-card p-1.5 ring-1 ring-hairline">
            <span className="flex items-center gap-1">
              <span className="rounded-pill bg-ai/15 px-1 text-[7px] leading-[11px] font-semibold text-ai">agent</span>
              <span className="rounded-pill bg-ok/15 px-1 text-[7px] leading-[11px] font-semibold text-ok">ok</span>
              <span className="rounded-pill bg-warn/15 px-1 text-[7px] leading-[11px] font-semibold text-warn">stale</span>
              <span className="rounded-pill bg-bad/15 px-1 text-[7px] leading-[11px] font-semibold text-bad">failed</span>
            </span>
            <span className="flex flex-1 items-end gap-1 px-0.5">
              {[45, 75, 35, 90, 60, 50].map((h, i) => (
                <span key={i} className="flex-1 rounded-t-[2px]" style={{ height: `${h}%`, background: `var(--cat-${i + 1})` }} />
              ))}
            </span>
          </div>
          <div className="flex w-16 shrink-0 flex-col items-center justify-end">
            <PhantomPose pose="waving" size={46} still noFloat noGlow />
          </div>
        </div>
      </div>
    </div>
  );
}

const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "contrast", label: "High contrast" },
  { value: "system", label: "System" },
];

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center gap-6 py-2.5 max-sm:flex-col max-sm:items-start max-sm:gap-2">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-foreground">{label}</p>
        {hint ? <p className="text-[12px] text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

/** Theme + palette, for a card-warm group (divided rows). */
export function AppearanceSettings() {
  const [theme, setTheme] = useTheme();
  const [palette, setPalette] = usePalette();
  const notice = usePaletteNotice();
  const resolved = useResolvedTheme();
  return (
    <>
      <Row label="Theme" hint="Dark is lifted for long sessions; High contrast is pure black and white.">
        <Segmented value={theme} onChange={(v: ThemePref) => setTheme(v)} options={THEME_OPTIONS} />
      </Row>
      <div className="flex flex-col gap-3 py-3">
        <div>
          <p className="text-[13px] text-foreground">Palette</p>
          <p className="text-[12px] text-muted-foreground">
            Every colour in Ruah: actions, agents, statuses, the map, charts and the Phantoms. Previews show the{" "}
            {resolved === "contrast" ? "high-contrast" : resolved} theme.
          </p>
        </div>
        {notice.show ? (
          <div className="flex flex-col gap-2 rounded-lg border border-hairline border-l-[3px] border-l-info bg-surface-2 px-3 py-2.5">
            <div>
              <p className="text-[12.5px] font-medium text-info">Dusk is now Indigo</p>
              <p className="text-[12px] leading-snug text-muted-foreground">
                Your saved Dusk palette now follows the Ruah design system: indigo for actions, dusty rose for agents (it
                was a lavender accent). Classic teal is the app&apos;s look from before.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button size="sm" variant="outline" onClick={notice.dismiss}>
                Keep Indigo
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPalette("classic")}>
                Use Classic teal
              </Button>
            </div>
          </div>
        ) : null}
        <RadioGroup.Root
          aria-label="Palette"
          value={palette}
          onValueChange={(v) => setPalette(v as PaletteId)}
          className="grid grid-cols-2 gap-3 max-sm:grid-cols-1"
        >
          {PALETTE_IDS.map((id) => {
            const p = PALETTES[id];
            const active = palette === id;
            return (
              <RadioGroup.Item
                key={id}
                value={id}
                aria-label={`${p.label}: ${p.description}`}
                className={cn(
                  "group/pal flex flex-col gap-2 rounded-xl p-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
                  active ? "bg-primary/10 ring-2 ring-primary" : "ring-1 ring-hairline hover:bg-accent/60",
                )}
              >
                <PalettePreview palette={id} theme={resolved} />
                <span className="flex items-start gap-2 px-1 pb-0.5">
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-[13px] font-medium text-foreground">
                      {p.label}
                      {id === "teal" ? (
                        <span className="rounded-pill bg-foreground/[0.07] px-1.5 text-[10px] font-medium text-muted-foreground">default</span>
                      ) : null}
                    </span>
                    <span className="block text-[12px] leading-snug text-muted-foreground">{p.description}</span>
                  </span>
                  <Check className={cn("mt-0.5 size-4 shrink-0 text-primary", !active && "invisible")} />
                </span>
              </RadioGroup.Item>
            );
          })}
        </RadioGroup.Root>
      </div>
    </>
  );
}
