// ⌘J (or Ctrl+Tab in the desktop app): recent chats across projects, cycled like app switching.
// Hold ⌘, press J again to go further back (⇧J forward), release ⌘ to open. A quick ⌘J tap jumps
// straight to the previous chat. Opened from the ⌘K palette (no key held) it stays open:
// ↑↓ + Enter, or click. The highlighted chat is prefetched so the switch paints from cache.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { History } from "lucide-react";
import type { RecentChat } from "@/lib/contracts";
import { chatsProjectId, prefetchChat, prefetchProject } from "@/lib/daemon";
import { useMruChats } from "@/lib/mru";
import { cycleIndex } from "@/lib/switching";
import { relativeTime } from "@/lib/time";
import { useWorkspace } from "@/lib/workspace";
import { useWorkbench } from "@/lib/workbench";
import { AgentMark } from "@/components/agent/ComposerControls";
import { Phantom } from "@/components/brand/Phantom";
import { ProjectTile } from "@/components/projects/ProjectBits";
import { useProjectActions } from "@/components/projects/useProjectActions";
import { useRecentChats } from "@/components/projects/useRecentChats";
import { cn } from "@/lib/utils";
import { isTerminalTarget } from "@/lib/terminal";

type Row = Pick<RecentChat, "id" | "projectId" | "projectName" | "projectRoot" | "title" | "agentId"> & {
  when?: string | number;
};

const MAX_ROWS = 12;

// Opened from elsewhere (the ⌘K action): no modifier is held, so it stays open.
const openers = new Set<() => void>();
export function openRecentChatsSwitcher() {
  for (const open of openers) open();
}

export function RecentChatsSwitcher() {
  const { daemon } = useWorkspace();
  const wb = useWorkbench();
  const actions = useProjectActions();
  const mru = useMruChats();
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  /** The modifier that opened it and must be released to commit (null = sticky). */
  const holding = useRef<"meta" | "ctrl" | null>(null);
  const recent = useRecentChats(daemon, open);
  const ownerId = chatsProjectId(daemon);
  const enabled = daemon.projectsSupported && daemon.source === "daemon";

  // MRU visits first (current chat on top), then other recent chats to fill the list.
  const rows = useMemo<Row[]>(() => {
    const fresh = new Map(recent.map((c) => [c.id, c]));
    const out: Row[] = [];
    const seen = new Set<string>();
    const current = ownerId && daemon.activeChatId ? daemon.activeChatId : null;
    const push = (r: Row) => {
      if (seen.has(r.id) || out.length >= MAX_ROWS) return;
      seen.add(r.id);
      out.push(r);
    };
    if (current) {
      const c = fresh.get(current);
      if (c) push({ ...c, when: c.updatedAt });
    }
    for (const e of mru) {
      const c = fresh.get(e.chatId);
      // A chat of the open project that is not in its list any more was deleted.
      if (!c && e.projectId === ownerId) continue;
      push({
        id: e.chatId,
        projectId: e.projectId,
        projectName: c?.projectName ?? e.projectName,
        projectRoot: c?.projectRoot ?? e.projectRoot,
        title: c?.title ?? e.title,
        agentId: c?.agentId ?? e.agentId,
        when: e.at,
      });
    }
    for (const c of recent) push({ ...c, when: c.updatedAt });
    return out;
  }, [recent, mru, ownerId, daemon.activeChatId]);

  const latest = useRef({ rows, index, open });
  latest.current = { rows, index, open };

  const commit = useCallback(
    (i?: number) => {
      const { rows, index } = latest.current;
      const row = rows[i ?? index];
      setOpen(false);
      holding.current = null;
      if (!row) return;
      if (row.projectId === ownerId && row.id === daemon.activeChatId) return;
      void actions.showChat(row);
    },
    [actions, ownerId, daemon.activeChatId],
  );
  const commitRef = useRef(commit);
  commitRef.current = commit;

  useEffect(() => {
    const show = () => {
      holding.current = null;
      setIndex(latest.current.rows.length > 1 ? 1 : 0);
      setOpen(true);
    };
    openers.add(show);
    return () => {
      openers.delete(show);
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      // Ctrl-J in the terminal is the shell's (newline), ⌘J stays the switcher.
      if (e.ctrlKey && !e.metaKey && isTerminalTarget(e.target)) return;
      const cmdJ = (e.metaKey || e.ctrlKey) && !e.altKey && k === "j";
      const ctrlTab = e.ctrlKey && e.key === "Tab";
      const { open, rows, index } = latest.current;
      if (cmdJ || ctrlTab) {
        e.preventDefault();
        e.stopPropagation();
        const delta = e.shiftKey ? -1 : 1;
        if (!open) {
          if (rows.length === 0) return;
          holding.current = ctrlTab || !e.metaKey ? "ctrl" : "meta";
          setIndex(rows.length > 1 ? (delta > 0 ? 1 : rows.length - 1) : 0);
          setOpen(true);
        } else {
          setIndex(cycleIndex(rows.length, index, delta));
        }
        return;
      }
      if (!open) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        holding.current = null;
        setOpen(false);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setIndex(cycleIndex(rows.length, index, e.key === "ArrowDown" ? 1 : -1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        commitRef.current();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!latest.current.open || holding.current === null) return;
      const released =
        (holding.current === "meta" && (e.key === "Meta" || !e.metaKey)) ||
        (holding.current === "ctrl" && (e.key === "Control" || !e.ctrlKey));
      if (released) commitRef.current();
    };
    const onBlur = () => {
      if (latest.current.open && holding.current !== null) {
        holding.current = null;
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [enabled]);

  // Prefetch the highlighted chat (and its project) so opening it paints at once.
  const target = open ? rows[index] : undefined;
  useEffect(() => {
    if (!target) return;
    const t = setTimeout(() => {
      void prefetchChat(target.projectId, target.id);
      if (target.projectId !== ownerId) void prefetchProject(target.projectId);
    }, 60);
    return () => clearTimeout(t);
  }, [target, ownerId]);

  useEffect(() => {
    if (open) wb.setPaletteOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  const agentName = (id: string) => daemon.agent?.agents?.available.find((a) => a.id === id)?.name ?? id;

  return (
    <div className="fixed inset-0 z-50 grid place-items-start justify-center bg-black/25 pt-[16vh]" onMouseDown={() => setOpen(false)}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Recent chats"
        onMouseDown={(e) => e.stopPropagation()}
        className="w-[min(560px,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-hairline bg-popover shadow-2xl"
      >
        <div className="flex h-10 items-center gap-2 border-b border-hairline px-3 text-ui-sm text-muted-foreground">
          <History className="size-3.5" />
          <span className="font-medium text-foreground">Recent chats</span>
          {/* Keys are read on the window (focus stays where it was): say which chat is highlighted. */}
          <span className="sr-only" aria-live="polite">
            {rows[index] ? `${rows[index]!.title || "Untitled chat"}, ${rows[index]!.projectName}` : ""}
          </span>
          <span className="ms-auto flex items-center gap-1 text-meta">
            {holding.current ? (
              <>
                <kbd className="kbd">J</kbd> next · <kbd className="kbd">⇧J</kbd> back · release to open
              </>
            ) : (
              <>
                <kbd className="kbd">↑</kbd>
                <kbd className="kbd">↓</kbd> move · <kbd className="kbd">↵</kbd> open
              </>
            )}
          </span>
        </div>
        {rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
            <Phantom expression="idle" size="sm" />
            <p className="text-ui-sm text-muted-foreground">No chats yet.</p>
          </div>
        ) : (
          <ul role="listbox" aria-label="Recent chats" className="max-h-[min(56vh,480px)] overflow-y-auto p-1.5">
            {rows.map((r, i) => {
              const here = r.projectId === ownerId;
              const current = here && r.id === daemon.activeChatId;
              return (
                <li
                  key={r.id}
                  role="option"
                  aria-selected={i === index}
                  onMouseMove={() => i !== index && setIndex(i)}
                  onClick={() => commit(i)}
                  className={cn(
                    "flex h-11 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-ui",
                    i === index ? "bg-accent text-foreground" : "text-muted-foreground",
                  )}
                >
                  <AgentMark name={agentName(r.agentId)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-foreground">{r.title || "Untitled chat"}</span>
                    <span className="flex items-center gap-1.5 truncate text-meta text-muted-foreground">
                      <ProjectTile project={{ id: r.projectId, name: r.projectName }} className="size-3.5 rounded-[4px] text-[8px]" />
                      <span className="truncate">{r.projectName}</span>
                      {current ? <span className="text-primary">· current</span> : null}
                    </span>
                  </span>
                  <span className="shrink-0 text-meta text-faint">{relativeTime(r.when)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
