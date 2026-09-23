import { useEffect, useState } from "react";
import { Check, ChevronsUpDown, FolderPlus, Layers, Workflow, X } from "lucide-react";
import type { Workspace } from "@/lib/workspace";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";

type Props = {
  workspace: Workspace;
  onSelect: (id: string) => void;
  /** Omitted when the daemon serves a single repo (a browser cannot open another one). */
  onCreate?: ((name: string) => void) | undefined;
  onClose?: ((id: string) => void) | undefined;
  /** Status dot colour class for the active project (daemon/agent state). */
  dotClass?: string;
  /** Second line under each project, e.g. the repo root on the daemon host. */
  detail?: string | null;
};

export function ProjectSwitcher({
  workspace,
  onSelect,
  onCreate,
  onClose,
  dotClass = "bg-primary",
  detail,
}: Props) {
  const [open, setOpen] = useState(false);
  const active = workspace.apps.find((a) => a.id === workspace.activeAppId) ?? workspace.apps[0]!;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={`${detail ?? active.name} · switch project (⌘K)`}
          className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-accent data-[state=open]:bg-accent"
        >
          <span className={cn("size-2 shrink-0 rounded-full", dotClass)} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
            {active.name}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground/70" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 rounded-xl border-hairline bg-popover p-0 shadow-xl"
      >
        <Command className="bg-transparent">
          <CommandInput placeholder="Switch project…" className="text-[13px]" />
          <CommandList>
            <CommandEmpty className="py-4 text-center text-[12.5px] text-muted-foreground">
              No project with that name.
            </CommandEmpty>
            <CommandGroup heading="Projects">
              {workspace.apps.map((a) => {
                const isActive = a.id === active.id;
                const arch = a.diagrams.filter((d) => d.mode === "architecture").length;
                const flows = a.diagrams.filter((d) => d.mode === "workflow").length;
                return (
                  <CommandItem
                    key={a.id}
                    value={a.name}
                    onSelect={() => {
                      onSelect(a.id);
                      setOpen(false);
                    }}
                    className="group/proj gap-2 rounded-md text-[13px]"
                  >
                    <Check
                      className={cn("size-3.5 shrink-0", isActive ? "text-primary" : "opacity-0")}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-foreground">
                        {a.name}
                      </span>
                      <span className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Layers className="size-2.5" />
                          {arch}
                        </span>
                        <span className="flex items-center gap-1">
                          <Workflow className="size-2.5" />
                          {flows}
                        </span>
                        {a.branch ? <span>{a.branch}</span> : null}
                        {detail ? <span className="truncate">{detail}</span> : null}
                      </span>
                    </span>
                    {onClose && workspace.apps.length > 1 ? (
                      <button
                        type="button"
                        aria-label={`Close ${a.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onClose(a.id);
                        }}
                        className="shrink-0 text-muted-foreground opacity-0 group-hover/proj:opacity-100 hover:text-destructive"
                      >
                        <X className="size-3" />
                      </button>
                    ) : null}
                  </CommandItem>
                );
              })}
            </CommandGroup>
            {onCreate ? (
              <CommandGroup heading="Actions">
                <CommandItem
                  value="new project"
                  onSelect={() => {
                    const name = window.prompt(
                      "Project name",
                      `project-${workspace.apps.length + 1}`,
                    );
                    if (name) onCreate(name);
                    setOpen(false);
                  }}
                  className="gap-2 rounded-md text-[13px]"
                >
                  <FolderPlus className="size-3.5 text-muted-foreground" />
                  New project
                </CommandItem>
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
