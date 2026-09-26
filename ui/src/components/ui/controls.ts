// The app's compact controls — ONE place for the button / field classes the pages use in their
// header rows, cards and lists (docs/design/README.md "Components"). Every page used to carry
// its own copy (h-7 vs h-8, rounded-md vs rounded-lg, 12 vs 12.5 px, disabled at 40 vs 50 %);
// these are the only ones now, and the kit `Button` (size "xs" / "icon-xs") draws the same.
//
// Rhythm: controls are 28 px (h-7 = `h-row`), 8 px radius, 12.5 px text (`text-ui-sm`), 14 px
// icons (`size-3.5`), gap 6 px. Forms use 32 px fields. Focus is the global 2 px ring
// (styles.css `:focus-visible`), so every control shows it without a class.
import { cn } from "@/lib/utils";

const base =
  "inline-flex h-7 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg text-ui-sm whitespace-nowrap transition-colors disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50";

/** Secondary action without chrome ("Refresh", "Check again"). */
export const quietButton = cn(base, "px-2 text-muted-foreground hover:bg-accent hover:text-foreground");

/** Secondary action that needs to be found ("Guard", "Connect"). */
export const solidButton = cn(base, "border border-hairline bg-surface-2 px-2.5 text-foreground hover:bg-surface-3");

/** The one primary action of a page or card ("New task", "Start preview"). */
export const primaryButton = cn(base, "bg-primary px-2.5 font-medium text-primary-foreground hover:bg-primary/90");

/** A primary action that hands work to an agent ("Ask agent"). */
export const aiButton = cn(base, "bg-ai px-2.5 font-medium text-ai-foreground hover:bg-ai/90");

/** Icon-only control; always give it an `aria-label` (and a `title` or tooltip). */
export const iconButton =
  "grid size-7 shrink-0 cursor-pointer place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:bg-accent data-[state=open]:text-foreground";

/** Single-line text field in forms and toolbars. */
export const fieldClass =
  "h-8 w-full min-w-0 rounded-lg border border-hairline bg-surface-0 px-2.5 text-ui text-foreground placeholder:text-faint focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50";
