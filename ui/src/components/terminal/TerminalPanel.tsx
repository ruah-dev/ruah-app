// The bottom terminal panel, on every page (AppShell): tabs per project (the daemon keeps them
// across reloads and project switches), resizable height (persisted), maximize, ⌃` to toggle.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { AlertTriangle, Globe, Loader2, Maximize2, Minimize2, Plus, SquareTerminal, X } from "lucide-react";
import { toast } from "sonner";
import { useWorkspace } from "@/lib/workspace";
import { useWorkbench } from "@/lib/workbench";
import { MIN_HEIGHT, terminalActions, terminalState, useTerminal, type TerminalInfo } from "@/lib/terminal";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { TerminalView } from "./TerminalView";
import { terminalErrorCopy } from "./error-copy";

const EMPTY: TerminalInfo[] = [];

/** ⌃` anywhere (terminal focused or not) toggles the panel. */
function useToggleKey() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.code === "Backquote") {
        e.preventDefault();
        e.stopPropagation();
        terminalActions.toggle();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

export function newTerminal() {
  terminalActions.create().catch((err: unknown) => {
    toast.error("Couldn't open a terminal", { description: terminalErrorCopy(err, terminalState().connection) });
  });
}

function Tab({
  terminal,
  active,
  tabStop,
  onSelect,
}: {
  terminal: TerminalInfo;
  active: boolean;
  /** Takes the strip's one Tab stop (the active tab, or the first when none is active). */
  tabStop: boolean;
  onSelect: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(terminal.title);
  const exited = terminal.status === "exited";
  return (
    <div
      role="tab"
      aria-selected={active}
      // One Tab stop for the strip (the active tab); ← / → move between tabs (tablist below).
      tabIndex={tabStop ? 0 : -1}
      title={`${terminal.title} — ${terminal.cwd}${exited ? ` (exited ${terminal.exitCode ?? ""})` : ""}\nDouble-click or F2 to rename · Delete closes`}
      onClick={onSelect}
      onDoubleClick={() => {
        setDraft(terminal.title);
        setEditing(true);
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        } else if (e.key === "F2") {
          e.preventDefault();
          setDraft(terminal.title);
          setEditing(true);
        } else if (e.key === "Delete") {
          e.preventDefault();
          terminalActions.kill(terminal.id);
        }
      }}
      onAuxClick={(e) => {
        if (e.button === 1) terminalActions.kill(terminal.id);
      }}
      className={cn(
        "group/tab relative flex h-7 max-w-48 shrink-0 cursor-default items-center gap-1.5 rounded-md ps-2 pe-1 text-ui-sm transition-colors select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      {terminal.kind === "preview" ? (
        <Globe className={cn("size-3.5 shrink-0", active ? "text-primary" : "", exited && "text-faint")} aria-label="live preview server" />
      ) : (
        <SquareTerminal className={cn("size-3.5 shrink-0", active ? "text-primary" : "", exited && "text-faint")} />
      )}
      {editing ? (
        <input
          autoFocus
          value={draft}
          aria-label="Terminal name"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            setEditing(false);
            terminalActions.rename(terminal.id, draft);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setDraft(terminal.title);
              setEditing(false);
            }
          }}
          className="h-5 w-28 rounded bg-background px-1 text-ui-sm text-foreground outline-none ring-1 ring-ring"
        />
      ) : (
        <span className={cn("truncate", exited && "line-through decoration-faint")}>{terminal.title}</span>
      )}
      <button
        type="button"
        aria-label={`Close ${terminal.title}`}
        // Only the active tab's close button is a Tab stop: the strip stays one stop plus one
        // button, and Delete on any focused tab closes it.
        tabIndex={active ? 0 : -1}
        onClick={(e) => {
          e.stopPropagation();
          terminalActions.kill(terminal.id);
        }}
        className={cn(
          "grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-surface-4 hover:text-foreground focus-visible:opacity-100",
          active ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100 group-focus-within/tab:opacity-100",
        )}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

export function TerminalPanel() {
  const t = useTerminal();
  const { daemon } = useWorkspace();
  const wb = useWorkbench();
  const project = daemon.project;
  const projectId = project?.id ?? null;
  const terminals = (projectId ? t.terminals[projectId] : undefined) ?? EMPTY;
  const listed = projectId !== null && t.terminals[projectId] !== undefined;
  const activeId = projectId ? t.active[projectId] : undefined;
  const panelRef = useRef<HTMLDivElement>(null);
  const autoCreated = useRef<string | null>(null);
  // The tallest the panel can be (its column minus 60 px), for the resize handle's range.
  const [maxHeight, setMaxHeight] = useState(0);
  const shown = t.open && !!project && daemon.source === "daemon";
  useToggleKey();

  useEffect(() => {
    const parent = panelRef.current?.parentElement;
    if (!shown || !parent) return;
    const measure = () => setMaxHeight(Math.round(parent.getBoundingClientRect().height - 60));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [shown]);

  // Connect once the panel has been opened (or was open before a reload), then list the
  // project's terminals whenever the project changes.
  useEffect(() => {
    if (t.open) terminalActions.connect();
  }, [t.open]);
  useEffect(() => {
    if (t.connection === "open" && projectId) terminalActions.list(projectId);
  }, [t.connection, projectId]);
  // Closing the last tab hides the panel (like VS Code).
  const prevCount = useRef<{ projectId: string | null; count: number }>({ projectId: null, count: 0 });
  useEffect(() => {
    const prev = prevCount.current;
    if (t.open && listed && prev.projectId === projectId && prev.count > 0 && terminals.length === 0) terminalActions.setOpen(false);
    prevCount.current = { projectId, count: listed ? terminals.length : 0 };
  }, [t.open, listed, projectId, terminals.length]);
  // Opening the panel on a project without terminals starts one (like VS Code).
  useEffect(() => {
    if (!t.open) {
      autoCreated.current = null;
      return;
    }
    if (t.connection !== "open" || !projectId || !listed || terminals.length > 0) return;
    if (autoCreated.current === projectId) return;
    autoCreated.current = projectId;
    newTerminal();
  }, [t.open, t.connection, projectId, listed, terminals.length]);

  if (!shown || !project) return null;
  const tabStopId = terminals.some((x) => x.id === activeId) ? activeId : terminals[0]?.id;
  const rangeMax = Math.max(MIN_HEIGHT, maxHeight);
  const shownHeight = Math.round(t.maximized ? rangeMax : Math.min(rangeMax, Math.max(MIN_HEIGHT, t.height)));

  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = panelRef.current?.getBoundingClientRect().height ?? t.height;
    const max = (panelRef.current?.parentElement?.getBoundingClientRect().height ?? window.innerHeight) - 60;
    if (t.maximized) terminalActions.setMaximized(false);
    const move = (ev: PointerEvent) => terminalActions.setHeight(Math.min(max, Math.max(MIN_HEIGHT, startH + (startY - ev.clientY))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "row-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const openPath = (rel: string, line?: number) => {
    wb.openPath(rel);
    if (line) wb.openCode(rel, [line, line]);
  };

  return (
    <section
      ref={panelRef}
      aria-label="Terminal"
      className={cn("relative flex shrink-0 flex-col border-t border-hairline", t.maximized && "min-h-0 flex-1 border-t-0")}
      style={t.maximized ? undefined : { height: t.height }}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal"
        aria-valuemin={MIN_HEIGHT}
        aria-valuemax={rangeMax}
        aria-valuenow={shownHeight}
        aria-valuetext={`${shownHeight} pixels${t.maximized ? ", maximized" : ""}`}
        tabIndex={0}
        onPointerDown={startDrag}
        onDoubleClick={() => terminalActions.setMaximized(!t.maximized)}
        onKeyDown={(e) => {
          // ↑ / ↓ resize by 24 px (Shift: 96 px); Enter maximizes / restores.
          if (e.key === "Enter") {
            e.preventDefault();
            terminalActions.setMaximized(!t.maximized);
            return;
          }
          if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
          e.preventDefault();
          const step = (e.shiftKey ? 96 : 24) * (e.key === "ArrowUp" ? 1 : -1);
          const max = (panelRef.current?.parentElement?.getBoundingClientRect().height ?? window.innerHeight) - 60;
          if (t.maximized) terminalActions.setMaximized(false);
          terminalActions.setHeight(Math.min(max, Math.max(MIN_HEIGHT, t.height + step)));
        }}
        className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize hover:bg-primary/30 focus-visible:bg-primary/40 focus-visible:outline-none"
      />
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-hairline bg-sidebar ps-2 pe-1">
        <span className="section-label pe-2">Terminal</span>
        <div
          role="tablist"
          aria-label="Terminals"
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
            if ((e.target as HTMLElement).getAttribute("role") !== "tab") return;
            const i = terminals.findIndex((x) => x.id === activeId);
            const n = terminals.length;
            if (n === 0) return;
            const next = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : (Math.max(0, i) + (e.key === "ArrowRight" ? 1 : -1) + n) % n;
            const term = terminals[next];
            if (!term) return;
            e.preventDefault();
            terminalActions.setActive(term.projectId, term.id);
            const list = e.currentTarget;
            requestAnimationFrame(() => list.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus());
          }}
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]"
        >
          {terminals.map((term) => (
            <Tab
              key={term.id}
              terminal={term}
              active={term.id === activeId}
              tabStop={term.id === tabStopId}
              onSelect={() => {
                terminalActions.setActive(term.projectId, term.id);
                terminalActions.focus();
              }}
            />
          ))}
          <IconButton label="New terminal (⌘T in the terminal)" onClick={newTerminal}>
            <Plus className="size-4" />
          </IconButton>
        </div>
        <IconButton label={t.maximized ? "Restore" : "Maximize"} onClick={() => terminalActions.setMaximized(!t.maximized)}>
          {t.maximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </IconButton>
        <IconButton label="Hide terminal (⌃`)" onClick={() => terminalActions.setOpen(false)}>
          <X className="size-4" />
        </IconButton>
      </div>
      <div className="relative min-h-0 flex-1" style={{ background: "var(--term-bg)" }}>
        {t.connection === "unavailable" ? (
          <div className="flex h-full items-start gap-2.5 p-4 text-ui-sm text-muted-foreground">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
            <p className="max-w-3xl leading-relaxed whitespace-pre-wrap">{t.reason}</p>
          </div>
        ) : terminals.length === 0 ? (
          <div className="flex h-full items-center justify-center gap-2 text-ui-sm text-muted-foreground">
            {t.connection === "open" && listed ? (
              <button type="button" onClick={newTerminal} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-primary hover:bg-accent">
                <Plus className="size-3.5" /> New terminal
              </button>
            ) : (
              <>
                <Loader2 className="size-3.5 animate-spin" /> {t.connection === "closed" ? "Reconnecting…" : "Connecting…"}
              </>
            )}
          </div>
        ) : (
          terminals.map((term) => (
            <TerminalView
              key={term.id}
              terminal={term}
              active={term.id === activeId}
              visible={term.id === activeId}
              fontSize={t.fontSize}
              focusSignal={t.focusSignal}
              projectRoot={project.root}
              onOpenPath={openPath}
            />
          ))
        )}
      </div>
    </section>
  );
}

/** Sidebar footer button: toggles the panel. */
export function TerminalToggleButton({ side = "top" }: { side?: "top" | "right" | "bottom" }) {
  const t = useTerminal();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Terminal"
          aria-pressed={t.open}
          onClick={() => terminalActions.toggle()}
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-md transition-colors hover:bg-accent hover:text-foreground",
            t.open ? "text-primary" : "text-muted-foreground",
          )}
        >
          <SquareTerminal className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side={side}>
        Terminal <span className="ms-1 text-muted-foreground">⌃`</span>
      </TooltipContent>
    </Tooltip>
  );
}
