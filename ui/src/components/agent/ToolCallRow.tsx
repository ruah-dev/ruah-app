// Visual patterns adapted from t3code apps/web/src/components/chat/MessagesTimeline.tsx
// (SimpleWorkEntryRow) (MIT): tool calls are quiet one-line rows that expand on click.
import { useState, type ReactNode } from "react";
import {
  Brain,
  ChevronRight,
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
import { runCommandInTerminal } from "@/components/terminal/actions";
import { cn } from "@/lib/utils";

export const iconByKind: Record<string, typeof Wrench> = {
  read: FileCode2,
  edit: Pencil,
  delete: Trash2,
  move: MoveRight,
  search: Search,
  execute: Terminal,
  think: Brain,
  fetch: Globe,
};

export const statusDot: Record<ToolCallView["status"], string> = {
  pending: "bg-info",
  in_progress: "bg-warn animate-pulse",
  completed: "bg-ok",
  failed: "bg-bad",
};

/** One quiet row that expands to show its body (thinking, tool output, context pack). */
export function RowDisclosure({
  icon: Icon,
  label,
  detail,
  trailing,
  children,
  defaultOpen = false,
  tone = "muted",
}: {
  icon: typeof Wrench;
  label: ReactNode;
  detail?: ReactNode;
  trailing?: ReactNode;
  children?: ReactNode;
  defaultOpen?: boolean | undefined;
  tone?: "muted" | "bad" | "ai";
}) {
  const [open, setOpen] = useState(defaultOpen);
  const canExpand = children !== undefined && children !== null && children !== false;
  return (
    <div className={cn("-mx-1.5 rounded-md", open ? "pb-1" : "")}>
      <button
        type="button"
        disabled={!canExpand}
        aria-expanded={canExpand ? open : undefined}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "group/row flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left transition-colors",
          canExpand ? "cursor-pointer hover:bg-accent" : "cursor-default",
        )}
      >
        <Icon
          className={cn(
            "size-3.5 shrink-0",
            tone === "bad" ? "text-bad" : tone === "ai" ? "text-ai" : "text-muted-foreground",
          )}
        />
        <span
          className={cn(
            "min-w-0 truncate text-[12.5px]",
            tone === "bad" ? "text-bad" : tone === "ai" ? "text-ai" : "text-muted-foreground",
          )}
        >
          {label}
        </span>
        {detail ? (
          <span className="min-w-0 shrink truncate font-mono text-[11px] text-faint">
            {detail}
          </span>
        ) : null}
        <span className="ms-auto flex shrink-0 items-center gap-2">
          {trailing}
          <ChevronRight
            className={cn(
              "size-3 text-faint transition-transform duration-150",
              open && "rotate-90",
              !canExpand && "invisible",
            )}
          />
        </span>
      </button>
      {open && canExpand ? <div className="ms-7 me-1.5 mt-1">{children}</div> : null}
    </div>
  );
}

export function ToolCallRow({
  call,
  onOpenPath,
  defaultOpen,
}: {
  call: ToolCallView;
  onOpenPath?: ((path: string) => void) | undefined;
  defaultOpen?: boolean | undefined;
}) {
  const Icon = iconByKind[call.kind] ?? Wrench;
  const loc = call.locations[0];
  // Titles often already name the file ("Edit src/x.ts"); only repeat the path when they don't.
  const detail = loc && !call.title.includes(loc.path) ? loc.path : undefined;
  const hasBody = call.locations.length > 0 || !!call.command || !!call.output;
  return (
    <RowDisclosure
      icon={Icon}
      label={call.title}
      detail={detail}
      tone={call.status === "failed" ? "bad" : "muted"}
      defaultOpen={defaultOpen}
      trailing={
        <span
          className={cn("size-1.5 rounded-full", statusDot[call.status])}
          title={call.status.replace("_", " ")}
        />
      }
    >
      {hasBody ? (
        <div className="space-y-1.5 pb-1">
          {call.locations.map((l, i) => (
            <button
              key={`${l.path}:${l.line ?? ""}:${i}`}
              type="button"
              onClick={() => onOpenPath?.(l.path)}
              className="block max-w-full truncate text-left font-mono text-[11.5px] text-primary hover:underline"
              title={l.path}
            >
              {l.path}
              {l.line !== undefined ? `:${l.line}` : ""}
            </button>
          ))}
          {call.command ? (
            <div className="flex min-w-0 items-center gap-2">
              <p className="min-w-0 truncate font-mono text-[11.5px] text-muted-foreground">
                $ {call.command}
              </p>
              {call.kind === "execute" ? (
                <button
                  type="button"
                  onClick={() => runCommandInTerminal(call.command!)}
                  title="Open a terminal with this command typed in (press Enter to run it)"
                  className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-primary hover:bg-accent"
                >
                  <Terminal className="size-3" />
                  Run in terminal
                </button>
              ) : null}
            </div>
          ) : null}
          {call.output ? (
            <pre className="max-h-48 overflow-auto rounded-lg bg-surface-1 p-2 font-mono text-[11px] leading-snug whitespace-pre-wrap text-foreground/85 ring-1 ring-hairline">
              {call.output}
            </pre>
          ) : null}
        </div>
      ) : null}
    </RowDisclosure>
  );
}
