// src/projects/chat-store.ts — chat persistence (CONTRACTS §5.3):
// $RUAH_HOME/projects/<projectId>/chats/<chatId>.jsonl, line 1 = the chat
// header (ChatInfo plus daemon-internal fields), then one TurnRecord per
// finished turn. Every change rewrites the file atomically (temp + rename), so
// a crash leaves the previous version; unparseable turn lines are skipped on
// read. Headers are cached per project after the first listing; turn lines
// are only read for chat.history.
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { ChatInfoSchema, TurnRecordSchema, type ChatInfo, type StreamEvent, type TurnRecord } from "../contracts/ws.js";
import { atomicWriteFileSync, readFirstLine } from "./fs-util.js";
import { ProjectStateStore } from "./project-state.js";

export const CHAT_TITLE_MAX = 80;
export const NEW_CHAT_TITLE = "New chat";
const CHAT_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/** The stored header: ChatInfo plus fields only the daemon reads. */
export interface ChatHeader extends ChatInfo {
  /** Agent session per agent id, resumed when the chat is reopened with that agent. */
  sessions?: Record<string, string>;
  /** True while the title is the placeholder; the first prompt replaces it. */
  autoTitle?: boolean;
}

export function isChatId(id: string): boolean {
  return CHAT_ID.test(id);
}

/** Title from a prompt: whitespace collapsed, at most 80 chars (… when cut). */
export function chatTitleFrom(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return NEW_CHAT_TITLE;
  return flat.length <= CHAT_TITLE_MAX ? flat : `${flat.slice(0, CHAT_TITLE_MAX - 1).trimEnd()}…`;
}

/** The wire shape: internal header fields stripped. */
export function toChatInfo(header: ChatHeader): ChatInfo {
  const { sessions: _sessions, autoTitle: _autoTitle, ...info } = header;
  return info;
}

/**
 * Appends a stream event to a stored turn, keeping the record small without
 * changing what the viewer redraws: consecutive text (and thought) chunks
 * merge; a tool_call/tool_result replaces the earlier state of the same
 * toolCallId in place (the viewer upserts by id, position keeps text
 * segmentation); a plan replaces the previous plan in place.
 */
export function appendStreamEvent(events: StreamEvent[], event: StreamEvent): void {
  const last = events.at(-1);
  if ((event.kind === "text" || event.kind === "thought") && last?.kind === event.kind) {
    events[events.length - 1] = { kind: event.kind, text: last.text + event.text };
    return;
  }
  if (event.kind === "tool_call" || event.kind === "tool_result") {
    const index = events.findIndex(
      (e) => (e.kind === "tool_call" || e.kind === "tool_result") && e.toolCall.toolCallId === event.toolCall.toolCallId,
    );
    if (index !== -1) {
      events[index] = event;
      return;
    }
  }
  if (event.kind === "plan") {
    const index = events.findIndex((e) => e.kind === "plan");
    if (index !== -1) {
      events[index] = event;
      return;
    }
  }
  events.push(event);
}

function parseHeader(line: string | undefined): ChatHeader | undefined {
  if (line === undefined || line.trim().length === 0) return undefined;
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    const parsed = ChatInfoSchema.safeParse(value);
    if (!parsed.success) return undefined;
    const header: ChatHeader = { ...parsed.data };
    const sessions = value.sessions;
    if (sessions !== null && typeof sessions === "object") {
      const entries = Object.entries(sessions).filter((e): e is [string, string] => typeof e[1] === "string");
      if (entries.length > 0) header.sessions = Object.fromEntries(entries);
    }
    if (value.autoTitle === true) header.autoTitle = true;
    return header;
  } catch {
    return undefined;
  }
}

export interface ChatStoreOptions {
  now?: () => Date;
  onError?: (line: string) => void;
}

export class ChatStore {
  private readonly cache = new Map<string, Map<string, ChatHeader>>();
  /** Per-project state.json (the last active chat, CONTRACTS §5.5). */
  readonly state: ProjectStateStore;

  constructor(
    readonly home: string,
    private readonly options: ChatStoreOptions = {},
  ) {
    this.state = new ProjectStateStore(home, options.onError !== undefined ? { onError: options.onError } : {});
  }

  /**
   * The chat last active in the project, persisted across daemon restarts:
   * a chat id that still exists, null when the project was left without one,
   * undefined when nothing (valid) was recorded.
   */
  activeChat(projectId: string): string | null | undefined {
    const stored = this.state.activeChat(projectId);
    if (stored === null || stored === undefined) return stored;
    return this.get(projectId, stored) !== undefined ? stored : undefined;
  }

  /** Remembers the active chat of a project in state.json (atomic write; unchanged values are not rewritten). */
  setActiveChat(projectId: string, chatId: string | null): void {
    this.state.setActiveChat(projectId, chatId);
  }

  chatsDir(projectId: string): string {
    return path.join(this.home, "projects", projectId, "chats");
  }

  chatFile(projectId: string, chatId: string): string {
    if (!isChatId(chatId)) throw new Error(`invalid chat id: ${chatId}`);
    return path.join(this.chatsDir(projectId), `${chatId}.jsonl`);
  }

  /** Newest (updatedAt) first. */
  list(projectId: string): ChatInfo[] {
    return [...this.headers(projectId).values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(toChatInfo);
  }

  get(projectId: string, chatId: string): ChatHeader | undefined {
    if (!isChatId(chatId)) return undefined;
    return this.headers(projectId).get(chatId);
  }

  create(projectId: string, init: { agentId: string; model?: string | undefined; title?: string | undefined }): ChatHeader {
    const now = this.now();
    const header: ChatHeader = {
      id: randomUUID(),
      projectId,
      title: init.title !== undefined ? chatTitleFrom(init.title) : NEW_CHAT_TITLE,
      agentId: init.agentId,
      ...(init.model !== undefined ? { model: init.model } : {}),
      createdAt: now,
      updatedAt: now,
      turnCount: 0,
      ...(init.title === undefined ? { autoTitle: true } : {}),
    };
    this.writeChat(header, []);
    return header;
  }

  history(projectId: string, chatId: string): TurnRecord[] {
    return this.readChat(projectId, chatId)?.turns ?? [];
  }

  /**
   * Stores a finished (or cancelled) turn and updates the header: turnCount,
   * updatedAt, lastNodeId, the agent session to resume, model, and the title
   * when it is still the placeholder. Undefined = unknown chat.
   */
  appendTurn(
    projectId: string,
    chatId: string,
    turn: TurnRecord,
    meta: { agentId: string; sessionId?: string | undefined; model?: string | undefined },
  ): ChatHeader | undefined {
    const chat = this.readChat(projectId, chatId);
    if (chat === undefined) return undefined;
    const turns = chat.turns.filter((t) => t.turnId !== turn.turnId);
    turns.push(turn);
    const { autoTitle, ...rest } = chat.header;
    const header: ChatHeader = {
      ...rest,
      turnCount: turns.length,
      updatedAt: this.now(),
      ...(turn.nodeId !== undefined ? { lastNodeId: turn.nodeId } : {}),
      ...(meta.model !== undefined ? { model: meta.model } : {}),
      ...(autoTitle === true ? { title: chatTitleFrom(turn.text) } : {}),
      ...(meta.sessionId !== undefined ? { sessions: { ...chat.header.sessions, [meta.agentId]: meta.sessionId } } : {}),
    };
    this.writeChat(header, turns);
    return header;
  }

  rename(projectId: string, chatId: string, title: string): ChatHeader | undefined {
    const chat = this.readChat(projectId, chatId);
    if (chat === undefined) return undefined;
    const { autoTitle: _autoTitle, ...rest } = chat.header;
    const flat = title.replace(/\s+/g, " ").trim();
    const header: ChatHeader = { ...rest, title: flat.length === 0 ? NEW_CHAT_TITLE : flat.slice(0, 200), updatedAt: this.now() };
    this.writeChat(header, chat.turns);
    return header;
  }

  delete(projectId: string, chatId: string): boolean {
    if (this.get(projectId, chatId) === undefined) return false;
    fs.rmSync(this.chatFile(projectId, chatId), { force: true });
    this.headers(projectId).delete(chatId);
    return true;
  }

  /** The newest `limit` chats of one project. */
  recentIn(projectId: string, limit: number): ChatInfo[] {
    return this.list(projectId).slice(0, Math.max(0, limit));
  }

  /** Headers of every chat of every project, newest first. */
  recent(limit: number): ChatInfo[] {
    const projectsDir = path.join(this.home, "projects");
    let projectIds: string[];
    try {
      projectIds = fs.readdirSync(projectsDir);
    } catch {
      return [];
    }
    const all: ChatInfo[] = [];
    for (const projectId of projectIds) all.push(...this.list(projectId));
    return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, Math.max(0, limit));
  }

  /** Drops the cached headers of a project (its chat files were rewritten on disk, e.g. a system repo rename). */
  reload(projectId: string): void {
    this.cache.delete(projectId);
  }

  // ----- internals -----

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private headers(projectId: string): Map<string, ChatHeader> {
    const cached = this.cache.get(projectId);
    if (cached !== undefined) return cached;
    const headers = new Map<string, ChatHeader>();
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.chatsDir(projectId));
    } catch {
      // no chats yet
    }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const header = parseHeader(readFirstLine(path.join(this.chatsDir(projectId), file)));
      if (header === undefined) {
        this.options.onError?.(`skipping chat file with an invalid header: ${file}`);
        continue;
      }
      if (header.projectId !== projectId || `${header.id}.jsonl` !== file) continue;
      headers.set(header.id, header);
    }
    this.cache.set(projectId, headers);
    return headers;
  }

  private readChat(projectId: string, chatId: string): { header: ChatHeader; turns: TurnRecord[] } | undefined {
    if (this.get(projectId, chatId) === undefined) return undefined;
    let raw: string;
    try {
      raw = fs.readFileSync(this.chatFile(projectId, chatId), "utf8");
    } catch {
      this.headers(projectId).delete(chatId);
      return undefined;
    }
    const lines = raw.split("\n");
    const header = parseHeader(lines[0]);
    if (header === undefined) return undefined;
    const turns: TurnRecord[] = [];
    for (const line of lines.slice(1)) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = TurnRecordSchema.safeParse(JSON.parse(line));
        if (parsed.success) turns.push(parsed.data);
      } catch {
        // partial or hand-edited line
      }
    }
    return { header, turns };
  }

  private writeChat(header: ChatHeader, turns: readonly TurnRecord[]): void {
    const lines = [JSON.stringify(header), ...turns.map((t) => JSON.stringify(t))];
    atomicWriteFileSync(this.chatFile(header.projectId, header.id), `${lines.join("\n")}\n`);
    this.headers(header.projectId).set(header.id, header);
  }
}
