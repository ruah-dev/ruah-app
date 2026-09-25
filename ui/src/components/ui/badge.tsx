import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/80",
        outline: "text-foreground",
        // Design-system badges: one per semantic role — a pill, the role's colour on its tint.
        brand: "rounded-pill border-brand/35 bg-brand/12 font-medium text-brand",
        ai: "rounded-pill border-ai/35 bg-ai/12 font-medium text-ai",
        ok: "rounded-pill border-ok/35 bg-ok/12 font-medium text-ok",
        warn: "rounded-pill border-warn/35 bg-warn/12 font-medium text-warn",
        bad: "rounded-pill border-bad/35 bg-bad/12 font-medium text-bad",
        info: "rounded-pill border-info/35 bg-info/12 font-medium text-info",
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
