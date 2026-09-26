import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex h-5 shrink-0 items-center gap-1 rounded-md border px-2 text-meta font-semibold whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/80",
        outline: "text-foreground",
        // Neutral count / metadata chip (no status): muted text on the raised surface.
        neutral: "border-hairline bg-surface-2 font-medium text-muted-foreground",
        // Design-system badges: one per semantic role — a pill, the role's colour on its tint
        // (opaque `pill-*`, so it reads the same on every surface; styles.css).
        brand: "rounded-pill border-brand/35 pill-brand font-medium",
        ai: "rounded-pill border-ai/35 pill-ai font-medium",
        ok: "rounded-pill border-ok/35 pill-ok font-medium",
        warn: "rounded-pill border-warn/35 pill-warn font-medium",
        bad: "rounded-pill border-bad/35 pill-bad font-medium",
        info: "rounded-pill border-info/35 pill-info font-medium",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
