import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The app's type scale (styles.css `@theme` `--text-*`). tailwind-merge only knows Tailwind's own
 * sizes, so without this list it took `text-ui-sm` for a colour and `cn("text-ui-sm", "text-faint")`
 * silently dropped the size. Keep in step with styles.css (ui/test/type-scale.test.ts checks).
 */
export const TYPE_SCALE = [
  "micro",
  "caption",
  "meta",
  "label",
  "ui-sm",
  "ui",
  "body",
  "title-sm",
  "title",
  "headline",
  "display",
] as const;

const twMerge = extendTailwindMerge({
  extend: { classGroups: { "font-size": [{ text: [...TYPE_SCALE] }] } },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
