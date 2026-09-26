import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// Ruah Design System kit (docs/design/ruah-design-system.html § Components): primary (the
// brand fill), ai (agent actions), soft (a tinted brand), ghost / outline, destructive; a 2 px
// focus ring in the ring colour. Colours are semantic tokens, so every palette × theme works.
// `soft` keeps its tint at or below 15 % (hover included): primary text on a 15 % tint of itself
// is the strongest tint the WCAG check (design/tokens.ts CONTRAST_PAIRS) holds to 4.5:1 / 7:1.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-ui font-medium cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow hover:bg-primary/90",
        ai: "bg-ai text-ai-foreground shadow hover:bg-ai/90",
        soft: "bg-primary/10 text-primary hover:bg-primary/15",
        destructive: "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        outline:
          "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      // `xs` / `icon-xs` are the app's compact controls (components/ui/controls.ts): header
      // rows, cards and lists. `sm` / `default` are for dialogs and empty-state actions.
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 px-3 text-ui-sm",
        xs: "h-7 gap-1.5 px-2.5 text-ui-sm [&_svg]:size-3.5",
        lg: "h-10 px-8",
        icon: "size-9",
        "icon-sm": "size-8",
        "icon-xs": "size-7 [&_svg]:size-3.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
