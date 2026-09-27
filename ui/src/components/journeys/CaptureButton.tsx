// The live preview's "Capture for a journey screen" (JOURNEYS.md §6): photographs the page and
// attaches it to one of the app's screens — the one whose route matches the page first.
import { Camera } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useDaemonSelector } from "@/lib/daemon";
import { screenForUrl } from "@/lib/journeys";
import { canCapturePreview, captureForScreen } from "@/lib/preview-capture";

export function CaptureButton({ url, disabled }: { url: string | null; disabled: boolean }) {
  const product = useDaemonSelector((s) => s.product);
  const httpOrigin = useDaemonSelector((s) => s.httpOrigin);
  if (!canCapturePreview() || !product || product.screens.length === 0) return null;
  const match = screenForUrl(product, url);
  const others = product.screens.filter((s) => s.id !== match?.id).slice(0, 40);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label="Capture for a journey screen"
        title="Capture for a journey screen"
        className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50 data-[state=open]:bg-accent"
      >
        <Camera className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-64 overflow-y-auto">
        <DropdownMenuLabel className="text-caption font-normal text-muted-foreground">Screenshot this page for…</DropdownMenuLabel>
        {match ? (
          <DropdownMenuItem onSelect={() => void captureForScreen(httpOrigin, match.id, match.name)}>
            <span className="min-w-0 flex-1 truncate">{match.name}</span>
            <span className="shrink-0 text-caption text-primary">this page</span>
          </DropdownMenuItem>
        ) : null}
        {match && others.length > 0 ? <DropdownMenuSeparator /> : null}
        {others.map((s) => (
          <DropdownMenuItem key={s.id} onSelect={() => void captureForScreen(httpOrigin, s.id, s.name)}>
            <span className="min-w-0 flex-1 truncate">{s.name}</span>
            {s.route ? <span className="max-w-[45%] shrink-0 truncate font-mono text-caption text-faint">{s.route}</span> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
