// A page's one row of controls: title on the left, the page's main controls on the right, and at
// most a ⋯ menu for everything secondary (the launcher has the rest).
import type { ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  leading,
  menu,
  children,
  className,
}: {
  title: ReactNode;
  /** Before the title (a drawer toggle). */
  leading?: ReactNode;
  /** DropdownMenuItems of the ⋯ menu (secondary actions). */
  menu?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-11 shrink-0 items-center gap-2 border-b border-hairline px-4 max-md:px-3",
        className,
      )}
    >
      {leading}
      <h1 className="heading min-w-0 truncate text-title text-foreground max-md:hidden">{title}</h1>
      <span className="flex-1" />
      {children}
      {menu ? <PageMenu>{menu}</PageMenu> : null}
    </div>
  );
}

export function PageMenu({ children, label = "More actions" }: { children: ReactNode; label?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={label}
        title={label}
        className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-accent data-[state=open]:text-foreground"
      >
        <MoreHorizontal className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
