// Recent chats across ALL projects for the ⌘K switcher and the ⌘J recent-chats switcher.
// The last answer is kept at module level so a switcher opens with a full list at once and
// refreshes in the background; the current project's chats come live from the daemon store.
import { useEffect, useMemo, useState } from "react";
import type { RecentChat } from "@/lib/contracts";
import { chatsProjectId, fetchRecentChats, type DaemonState } from "@/lib/daemon";

let last: RecentChat[] = [];

export function useRecentChats(daemon: DaemonState, active: boolean, limit = 200): RecentChat[] {
  const [chats, setChats] = useState<RecentChat[]>(last);
  const connected = daemon.source === "daemon" && daemon.connection === "open" && !!daemon.httpOrigin;

  useEffect(() => {
    if (!active || !connected) return;
    let cancelled = false;
    fetchRecentChats(limit)
      .then((list) => {
        last = list;
        if (!cancelled) setChats(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [active, connected, limit, daemon.chats]);

  // The open project's chats are fresher in the store (titles, new chats, deletions). During a
  // cached switch the store's chats already belong to the target project.
  const ownerId = chatsProjectId(daemon);
  const owner =
    ownerId === null
      ? null
      : daemon.project?.id === ownerId
        ? daemon.project
        : (daemon.recentProjects.find((p) => p.id === ownerId) ?? null);
  return useMemo(() => {
    if (!owner) return chats;
    const live: RecentChat[] = daemon.chats.map((c) => ({ ...c, projectName: owner.name, projectRoot: owner.root }));
    const others = chats.filter((c) => c.projectId !== owner.id);
    return [...live, ...others].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }, [chats, daemon.chats, owner]);
}
