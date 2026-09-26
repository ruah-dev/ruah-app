// Chats: recent conversations across ALL projects (GET /api/chats/recent), grouped by project.
// Opening a chat of another project switches the project first, then opens the chat.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { MessageSquarePlus, RefreshCw, Search } from "lucide-react";
import { EmptyState as GhostState } from "@/components/brand/EmptyState";
import type { PhantomPoseName } from "@/components/brand/PhantomPose";
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
import { iconButton, primaryButton, quietButton } from "@/components/ui/controls";
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
          <button type="button" onClick={actions.startChat} className={primaryButton}>
            <MessageSquarePlus className="size-3.5" />
            New chat
          </button>
        ) : null}
        <button type="button" aria-label="Refresh" title="Refresh" onClick={load} disabled={!connected} className={iconButton}>
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
            pose="sleeping"
            eyebrow="Offline"
            title="No daemon connected"
            body="Chats are stored by the Ruah daemon. Start the Ruah app (or ruah app serve) to see them."
          />
        ) : error ? (
          <EmptyState
            pose="detective"
            eyebrow="Couldn't load"
            title="Couldn't load chats"
            body={`${error.replace(/\.$/, "")}. Check that Ruah is still running, then try again.`}
            action={
              <button type="button" className={quietButton} onClick={load}>
                <RefreshCw className="size-3.5" /> Try again
              </button>
            }
          />
        ) : chats === null ? (
          <div role="status" aria-live="polite" className="space-y-1 pt-1">
            <span className="sr-only">Loading chats…</span>
            {Array.from({ length: 7 }, (_, i) => (
              <div key={i} className="flex h-11 items-center gap-3 px-3">
                <Skeleton className="size-5 rounded-md" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <Skeleton className="h-3 rounded" style={{ width: `${58 - ((i * 13) % 24)}%` }} />
                  <Skeleton className="h-2.5 w-1/4 rounded" />
                </div>
                <Skeleton className="h-2.5 w-8 rounded" />
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            pose={query ? "searching" : "chatting"}
            eyebrow={query ? undefined : "Chats"}
            title={query ? "No chat matches" : "No chats yet"}
            body={
              query
                ? "Try another word from the title or the project name."
                : "Ask the agent anything, or about an element on the map — every conversation is kept here, per project."
            }
            action={
              query ? (
                <button type="button" className={quietButton} onClick={() => setQuery("")}>
                  Clear the filter
                </button>
              ) : daemon.projectsSupported && daemon.project ? (
                <button type="button" className={primaryButton} onClick={actions.startChat}>
                  <MessageSquarePlus className="size-3.5" /> New chat
                </button>
              ) : undefined
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
                  <ProjectTile project={{ id: r.projectId, name: r.name }} className="size-5 text-micro" />
                  {/* The name keeps its width (up to half the row); the long path is what gets cut. */}
                  <span className="max-w-[50%] shrink-0 truncate text-ui font-medium text-foreground">{r.name}</span>
                  <KindBadge kind={kindOf(r.projectId)} />
                  {r.projectId === daemon.project?.id ? (
                    <span className="shrink-0 rounded-[5px] pill-primary px-1.5 text-micro font-medium">
                      current
                    </span>
                  ) : null}
                  <span className="ms-auto min-w-0 truncate font-mono text-meta text-faint">
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
                    <span className="block truncate text-ui text-foreground" title={r.chat.title || undefined}>
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

/** Page states: sleeping (offline), detective (failed), searching (no match), chatting (none). */
function EmptyState({
  title,
  body,
  pose,
  eyebrow,
  action,
}: {
  title: string;
  body: string;
  pose: PhantomPoseName;
  eyebrow?: string | undefined;
  action?: ReactNode;
}) {
  return (
    <GhostState
      pose={pose}
      eyebrow={eyebrow}
      title={title}
      body={body}
      actions={action}
      className="mx-auto max-w-md"
      live={pose === "detective" ? "polite" : undefined}
    />
  );
}
