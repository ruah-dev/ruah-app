// A compact theme + palette switcher for the shell (top bar or sidebar footer): a quiet icon
// button that opens a popover with the theme and the four palettes (each with its six role
// colours, drawn from a data-ruah-preview scope so they are the real tokens). Same stores as
// Settings → Appearance (lib/theme.ts), so both stay in sync after a reload; within a session
// the page reflects the change immediately through <html data-theme / data-palette>. Both groups
// are ARIA radio groups (Radix): one Tab stop each, arrow keys move and choose.
import * as RadioGroup from "@radix-ui/react-radio-group";
import { Check, Palette } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { PALETTES, PALETTE_IDS, type PaletteId } from "@/design/tokens";
import { usePalette, useTheme, type ThemePref } from "@/lib/theme";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useResolvedTheme } from "./AppearanceSettings";

const ROLES = ["brand", "ai", "ok", "warn", "bad", "info"] as const;
const THEMES: { value: ThemePref; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "contrast", label: "Contrast" },
  { value: "system", label: "System" },
];

export function AppearanceMenu({ className, side = "bottom" }: { className?: string; side?: "top" | "bottom" | "left" | "right" }) {
  const [theme, setTheme] = useTheme();
  const [palette, setPalette] = usePalette();
  const resolved = useResolvedTheme();
  return (
    <Popover>
      <PopoverTrigger
        aria-label="Appearance: theme and palette"
        title="Appearance"
        className={cn(
          "relative grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground",
          className,
        )}
      >
        <Palette className="size-3.5" />
        <span aria-hidden className="absolute end-1 bottom-1 size-1.5 rounded-full bg-primary ring-1 ring-background" />
      </PopoverTrigger>
      <PopoverContent side={side} align="end" sideOffset={6} className="w-72 rounded-xl border-hairline p-2 shadow-elevated">
        <p className="px-1.5 pt-1 pb-1.5 text-[11px] font-medium tracking-[0.14em] text-faint uppercase">Theme</p>
        <RadioGroup.Root
          aria-label="Theme"
          value={theme}
          onValueChange={(v) => setTheme(v as ThemePref)}
          className="grid grid-cols-4 gap-1 px-1"
        >
          {THEMES.map((t) => (
            <RadioGroup.Item
              key={t.value}
              value={t.value}
              className={cn(
                "h-7 rounded-md text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                theme === t.value ? "bg-primary/12 font-medium text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {t.label}
            </RadioGroup.Item>
          ))}
        </RadioGroup.Root>
        <p className="px-1.5 pt-3 pb-1.5 text-[11px] font-medium tracking-[0.14em] text-faint uppercase">Palette</p>
        <RadioGroup.Root
          aria-label="Palette"
          value={palette}
          onValueChange={(v) => setPalette(v as PaletteId)}
          className="flex flex-col gap-0.5"
        >
          {PALETTE_IDS.map((id) => (
            <RadioGroup.Item
              key={id}
              value={id}
              aria-label={PALETTES[id].label}
              className={cn(
                "flex h-9 items-center gap-2.5 rounded-md px-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                palette === id ? "bg-accent" : "hover:bg-accent/60",
              )}
            >
              <span aria-hidden data-ruah-preview={`${resolved}:${id}`} className="flex shrink-0 overflow-hidden rounded-[4px] ring-1 ring-hairline">
                {ROLES.map((r) => (
                  <span key={r} className="h-4 w-2.5" style={{ background: `var(--ph-${r})` }} />
                ))}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground">{PALETTES[id].label}</span>
              <Check className={cn("size-3.5 shrink-0 text-primary", palette !== id && "invisible")} />
            </RadioGroup.Item>
          ))}
        </RadioGroup.Root>
        <div className="mt-2 border-t border-hairline px-1.5 pt-2">
          <Link to="/settings" className="text-[12px] text-muted-foreground hover:text-foreground">
            Previews in Settings → Appearance
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
