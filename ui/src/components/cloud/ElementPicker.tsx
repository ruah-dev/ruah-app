// Link-to-element combobox for a cloud resource: searchable list of architecture elements, the
// current link with an "auto" / "manual" badge, and Unlink. POST /api/cloud/link.
import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, Link2, Loader2, Unlink } from "lucide-react";
import type { ArchNode, CloudResource } from "@/lib/contracts";
import { kindFor, isFlowType } from "@/lib/architecture";
import { linkCloudResource } from "@/lib/integrations";
import { kindStyles } from "@/components/explorer/kinds";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export function LinkBadge({ manual, source }: { manual: boolean; source?: string | undefined }) {
  const title = manual
    ? "Linked by hand"
    : source === "tag"
      ? "Linked automatically from the ruah:node tag"
      : source === "name"
        ? "Linked automatically by name"
        : "Linked automatically";
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-4 shrink-0 items-center rounded px-1 text-micro font-medium tracking-wide uppercase",
        manual ? "bg-primary/15 text-primary" : "bg-foreground/[0.07] text-muted-foreground",
      )}
    >
      {manual ? "manual" : "auto"}
    </span>
  );
}

export function ElementPicker({
  resource,
  nodes,
  manual,
  disabled,
  className,
}: {
  resource: CloudResource;
  nodes: ArchNode[];
  manual: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const linked = resource.linkedNodeId ? nodes.find((n) => n.id === resource.linkedNodeId) : undefined;
  const candidates = useMemo(() => nodes.filter((n) => !isFlowType(n.type)), [nodes]);

  const choose = async (nodeId: string | null) => {
    setOpen(false);
    if (nodeId === (resource.linkedNodeId ?? null)) return;
    setBusy(true);
    setError(null);
    const res = await linkCloudResource(resource.id, nodeId);
    setBusy(false);
    if (!res.ok) setError(res.message);
  };

  const style = linked ? kindStyles[kindFor(linked.type)] : null;
  const Icon = style?.icon;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled || busy}
          aria-label={linked ? `Linked to ${linked.name}. Change link` : `Link ${resource.name} to an element`}
          title={error ?? undefined}
          className={cn(
            "group/pick flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left text-ui-sm transition-colors hover:bg-accent disabled:opacity-50",
            error && "text-bad",
            className,
          )}
        >
          {busy ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : Icon ? (
            <Icon className={cn("size-3.5 shrink-0", style!.color)} />
          ) : (
            <Link2 className="size-3.5 shrink-0 text-faint" />
          )}
          {linked ? (
            <>
              <span className="min-w-0 truncate text-foreground/90">{linked.name}</span>
              <LinkBadge manual={manual} source={resource.linkSource} />
            </>
          ) : resource.linkedNodeId ? (
            <span className="min-w-0 truncate font-mono text-label text-muted-foreground">
              {resource.linkedNodeId}
            </span>
          ) : (
            <span className="min-w-0 truncate text-faint group-hover/pick:text-muted-foreground">
              {error ? "Link failed — retry" : "Link element…"}
            </span>
          )}
          <ChevronsUpDown className="ms-auto size-3 shrink-0 text-muted-foreground/0 group-hover/pick:text-faint" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 border-hairline p-0">
        <Command>
          <CommandInput placeholder="Find an element…" className="h-9 text-ui" />
          <CommandList className="max-h-72">
            <CommandEmpty className="py-5 text-center text-ui-sm text-muted-foreground">
              No element matches.
            </CommandEmpty>
            <CommandGroup heading="Elements">
              {candidates.map((n) => {
                const s = kindStyles[kindFor(n.type)];
                const NIcon = s.icon;
                const active = n.id === resource.linkedNodeId;
                return (
                  <CommandItem
                    key={n.id}
                    value={`${n.name} ${n.id} ${n.path ?? ""} ${n.type}`}
                    onSelect={() => void choose(n.id)}
                    className="gap-2 text-ui"
                  >
                    <NIcon className={cn("size-3.5", s.color)} />
                    <span className="min-w-0 truncate">{n.name}</span>
                    <span className="ms-auto max-w-28 truncate font-mono text-caption text-muted-foreground">
                      {n.path ?? n.type}
                    </span>
                    <Check className={cn("size-3.5 shrink-0 text-primary", !active && "invisible")} />
                  </CommandItem>
                );
              })}
            </CommandGroup>
            {resource.linkedNodeId ? (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    value="__unlink__"
                    onSelect={() => void choose(null)}
                    className="gap-2 text-ui text-muted-foreground"
                  >
                    <Unlink className="size-3.5" />
                    Unlink
                  </CommandItem>
                </CommandGroup>
              </>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
