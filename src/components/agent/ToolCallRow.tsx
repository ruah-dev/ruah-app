import { useState } from "react";
import {
  Brain,
  FileCode2,
  Globe,
  MoveRight,
  Pencil,
  Search,
  Terminal,
  Trash2,
  Wrench,
} from "lucide-react";
import type { ToolCallView } from "@/lib/contracts";
import { cn } from "@/lib/utils";

const iconByKind: Record<string, typeof Wrench> = {
  read: FileCode2,
  edit: Pencil,
  delete: Trash2,
  move: MoveRight,
  search: Search,
  execute: Terminal,
  think: Brain,
  fetch: Globe,
};

const statusDot: Record<ToolCallView["status"], string> = {
  pending: "bg-muted-foreground",
  in_progress: "bg-warn animate-pulse",
  completed: "bg-ok",
  failed: "bg-bad",
};

export function Disclosure({
  label,
  children,
  defaultOpen = false,
}: {
  label: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground"
      >
        {label} {open ? "▾" : "▸"}
      </button>
      {open ? children : null}
    </div>
  );
}

export function ToolCallRow({
  call,
  onOpenPath,
}: {
  call: ToolCallView;
  onOpenPath?: ((path: string) => void) | undefined;
}) {
  const Icon = iconByKind[call.kind] ?? Wrench;
  const loc = call.locations[0];
  return (
    <div className="rounded-[4px] border border-hairline bg-surface-2/60 px-2 py-1.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-[11.5px] text-foreground">{call.title}</span>
        <span
          className={cn("ml-auto size-1.5 shrink-0 rounded-full", statusDot[call.status])}
          title={call.status.replace("_", " ")}
        />
      </div>
      {loc ? (
        <button
          type="button"
          onClick={() => onOpenPath?.(loc.path)}
          className="mt-0.5 block max-w-full truncate pl-5 text-left font-mono text-[10.5px] text-primary hover:underline"
          title={loc.path}
        >
          {loc.path}
          {loc.line !== undefined ? `:${loc.line}` : ""}
        </button>
      ) : null}
      {call.command ? (
        <p className="mt-0.5 truncate pl-5 font-mono text-[10.5px] text-muted-foreground">
          $ {call.command}
        </p>
      ) : null}
      {call.output ? (
        <div className="mt-1 pl-5">
          <Disclosure label="output">
            <pre className="mt-1 max-h-48 overflow-auto rounded-[4px] bg-surface-2 p-2 font-mono text-[10.5px] leading-snug whitespace-pre-wrap text-foreground/80">
              {call.output}
            </pre>
          </Disclosure>
        </div>
      ) : null}
    </div>
  );
}
