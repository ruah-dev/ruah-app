// Chats: recent conversations across ALL projects (GET /api/chats/recent), grouped by project.
// Opening a chat of another project switches the project first, then opens the chat.
import { useCallback, useEffect, useMemo, useState } from "react";
import { MessageSquarePlus, MessagesSquare, RefreshCw, Search } from "lucide-react";
import type { RecentChat } from "@/lib/contracts";
import { fetchRecentChats, prefetchChat, prefetchProject } from "@/lib/daemon";
import { absoluteTime, prettyPath, relativeTime } from "@/lib/time";
import { useWorkspace } from "@/lib/workspace";
import { PageHeader } from "@/components/shell/AppShell";
import { VirtualList } from "@/components/common/VirtualList";
import { AgentMark } from "@/components/agent/ComposerControls";
import { KindBadge, ProjectTile } from "@/components/projects/ProjectBits";
import { canManageProjects, useProjectActions } from "@/components/projects/useProjectActions";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type Row =
  | { type: "group"; key: string; projectId: string; name: string; root: string; count: number }
  | { type: "chat"; key: string; chat: RecentChat };

const GROUP_H = 44;
const CHAT_H = 48;

export function ChatsPage() {
  const { daemon } = useWorkspace();
  const actions = useProjectActions();
  const connected = canManageProjects(daemon);
  const [chats, setChats] = useState<RecentChat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const load = useCallback(() => {
    if (!connected) return;
    setError(null);
    fetchRecentChats(300)
      .then(setChats)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [connected]);

  // Reload when the current project's chat list changes (new chat, rename, delete).
  useEffect(load, [load, daemon.chats]);

  const agentName = (id: string) =>
    daemon.agent?.agents?.available.find((a) => a.id === id)?.name ?? id;

  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase();
    const list = (chats ?? []).filter(
      (c) => !q || c.title.toLowerCase().includes(q) || c.projectName.toLowerCase().includes(q),
    );
    const groups = new Map<string, RecentChat[]>();
    for (const c of list) {
      const g = groups.get(c.projectId);
      if (g) g.push(c);
      else groups.set(c.projectId, [c]);
    }
    const out: Row[] = [];
    // Current project first, then by most recent activity.
    const ordered = [...groups.entries()].sort(([a, ga], [b, gb]) => {
      if (a === daemon.project?.id) return -1;
      if (b === daemon.project?.id) return 1;
      return Date.parse(gb[0]!.updatedAt) - Date.parse(ga[0]!.updatedAt);
    });
    for (const [projectId, g] of ordered) {
      out.push({
        type: "group",
        key: `g:${projectId}`,
        projectId,
        name: g[0]!.projectName,
        root: g[0]!.projectRoot,
        count: g.length,
      });
      for (const c of g) out.push({ type: "chat", key: c.id, chat: c });
    }
    return out;
  }, [chats, query, daemon.project?.id]);

  const chatIndexes = useMemo(
    () => rows.flatMap((r, i) => (r.type === "chat" ? [i] : [])),
    [rows],
  );
  const activeRow = chatIndexes[Math.min(active, chatIndexes.length - 1)] ?? -1;

  const kindOf = (projectId: string) =>
    daemon.recentProjects.find((p) => p.id === projectId)?.kind ?? "repo";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Chats">
        {daemon.projectsSupported && daemon.project ? (
          <button
            type="button"
            onClick={actions.startChat}
            className="flex h-7 items-center gap-1.5 rounded-md px-2 text-ui-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <MessageSquarePlus className="size-3.5" />
            New chat
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Refresh"
          onClick={load}
          disabled={!connected}
          className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
        >
          <RefreshCw className="size-3.5" />
        </button>
      </PageHeader>

      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col px-4 pt-5 max-md:px-3">
        <div className="mb-3 flex h-9 shrink-0 items-center gap-2 rounded-lg bg-surface-2 px-3 shadow-[inset_0_0_0_1px_var(--color-hairline)]">
          <Search className="size-3.5 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, chatIndexes.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter") {
                const row = rows[activeRow];
                if (row?.type === "chat") void actions.showChat(row.chat);
              }
            }}
            placeholder="Filter chats and projects…"
            aria-label="Filter chats"
            className="h-full min-w-0 flex-1 bg-transparent text-ui outline-none placeholder:text-faint"
          />
          {chats ? (
            <span className="shrink-0 text-meta text-muted-foreground">
              {chats.length} {chats.length === 1 ? "chat" : "chats"}
            </span>
          ) : null}
        </div>

        {!connected ? (
          <EmptyState
            title="No daemon connected"
            body="Chats are stored by the Ruah daemon. Start the Ruah app (or ruah app serve) to see them."
          />
        ) : error ? (
          <EmptyState title="Couldn't load chats" body={error} />
        ) : chats === null ? (
          <div className="space-y-2 pt-1">
            {Array.from({ length: 7 }, (_, i) => (
              <Skeleton key={i} className="h-10 rounded-lg bg-foreground/[0.05]" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title={query ? "No chat matches" : "No chats yet"}
            body={
              query
                ? "Try another word from the title or the project name."
                : "Select an element on the map and ask the agent about it — every conversation is kept here, per project."
            }
          />
        ) : (
          <VirtualList
            items={rows}
            role="list"
            aria-label="Recent chats"
            className="-mx-1 flex-1 px-1 pb-6"
            itemHeight={(r) => (r.type === "group" ? GROUP_H : CHAT_H)}
            getKey={(r) => r.key}
            activeIndex={activeRow}
            renderItem={(r, i) =>
              r.type === "group" ? (
                <div className="flex h-full items-end gap-2 px-2 pb-1.5">
                  <ProjectTile project={{ id: r.projectId, name: r.name }} className="size-5 text-[10px]" />
                  <span className="truncate text-ui font-medium text-foreground">{r.name}</span>
                  <KindBadge kind={kindOf(r.projectId)} />
                  {r.projectId === daemon.project?.id ? (
                    <span className="shrink-0 rounded-[5px] bg-primary/12 px-1.5 text-[10.5px] font-medium text-primary">
                      current
                    </span>
                  ) : null}
                  <span className="ms-auto truncate font-mono text-meta text-faint">
                    {prettyPath(r.root)}
                  </span>
                </div>
              ) : (
                <button
                  type="button"
                  role="listitem"
                  data-active={i === activeRow}
                  onMouseEnter={() => {
                    setActive(chatIndexes.indexOf(i));
                    // Hover prefetch: opening it (even in another project) paints from cache.
                    void prefetchChat(r.chat.projectId, r.chat.id);
                    if (r.chat.projectId !== daemon.project?.id) void prefetchProject(r.chat.projectId);
                  }}
                  onClick={() => void actions.showChat(r.chat)}
                  className={cn(
                    "flex h-[calc(100%-4px)] w-full min-w-0 items-center gap-3 rounded-lg px-3 text-left transition-colors",
                    "hover:bg-accent/70 data-[active=true]:bg-accent",
                    r.chat.id === daemon.activeChatId && "shadow-[inset_2px_0_0_var(--color-primary)]",
                  )}
                >
                  <AgentMark name={agentName(r.chat.agentId)} className="size-5 text-[9px]" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ui text-foreground">
                      {r.chat.title || "Untitled chat"}
                    </span>
                    <span className="block truncate text-meta text-muted-foreground">
                      {agentName(r.chat.agentId)}
                      {r.chat.model ? ` · ${r.chat.model}` : ""} · {r.chat.turnCount}{" "}
                      {r.chat.turnCount === 1 ? "turn" : "turns"}
                    </span>
                  </span>
                  <span
                    className="shrink-0 text-meta text-muted-foreground"
                    title={absoluteTime(r.chat.updatedAt)}
                  >
                    {relativeTime(r.chat.updatedAt)}
                  </span>
                </button>
              )
            }
          />
        )}
      </div>
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-3 py-16 text-center">
      <span className="grid size-10 place-items-center rounded-xl bg-surface-2 text-muted-foreground">
        <MessagesSquare className="size-4.5" />
      </span>
      <p className="text-title font-medium">{title}</p>
      <p className="text-ui-sm leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}
