// Most-recently-used chats across projects (⌘J switcher), kept in localStorage so the order
// survives reloads and app restarts. The shell records a visit whenever the active chat changes.
import { useEffect, useSyncExternalStore } from "react";
import type { DaemonState } from "./daemon";
import { MRU_MAX, pruneMru, touchMru, type MruChat } from "./switching";

const KEY = "ruah.mru.chats.v1";

let list: MruChat[] = [];
let loaded = false;
const listeners = new Set<() => void>();

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (Array.isArray(parsed))
      list = parsed.filter(
        (e): e is MruChat =>
          !!e && typeof e === "object" && typeof (e as MruChat).chatId === "string" && typeof (e as MruChat).projectId === "string",
      );
  } catch {
    list = [];
  }
}

function commit(next: MruChat[]) {
  list = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable */
  }
  for (const l of listeners) l();
}

export function recordChatVisit(entry: Omit<MruChat, "at">) {
  load();
  const head = list[0];
  if (head && head.chatId === entry.chatId && head.title === entry.title) return;
  commit(touchMru(list, { ...entry, at: Date.now() }, MRU_MAX));
}

export function forgetChats(ids: Iterable<string>) {
  load();
  const gone = new Set(ids);
  const next = pruneMru(list, gone);
  if (next.length !== list.length) commit(next);
}

export function mruChats(): MruChat[] {
  load();
  return list;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const EMPTY: MruChat[] = [];

export function useMruChats(): MruChat[] {
  return useSyncExternalStore(subscribe, mruChats, () => EMPTY);
}

/** Records the active chat of the current project as a visit (and keeps its title fresh). */
export function useRecordChatVisits(daemon: DaemonState) {
  const project = daemon.project;
  const chat = daemon.chats.find((c) => c.id === daemon.activeChatId);
  const settled = !daemon.projectSwitch;
  useEffect(() => {
    if (!settled || !project || !chat) return;
    recordChatVisit({
      chatId: chat.id,
      projectId: project.id,
      projectName: project.name,
      projectRoot: project.root,
      title: chat.title,
      agentId: chat.agentId,
    });
  }, [settled, project, chat]);

  // Chats deleted in this project leave the MRU list too.
  const projectId = project?.id;
  const chats = daemon.chats;
  useEffect(() => {
    // An empty list may simply not have arrived yet (right after a switch): prune only real lists.
    if (!projectId || !settled || chats.length === 0) return;
    const known = new Set(chats.map((c) => c.id));
    const gone = mruChats()
      .filter((e) => e.projectId === projectId && !known.has(e.chatId))
      .map((e) => e.chatId);
    if (gone.length) forgetChats(gone);
  }, [projectId, chats, settled]);
}
