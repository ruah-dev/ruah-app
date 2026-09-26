// Regression: deleting an element saved architecture.json straight away and nothing could bring it
// back — ⌘Z did nothing (the only undo was per agent turn). The viewer now keeps its own map-edit
// history: undo / redo re-save the map, rapid edits of one thing are one step, and any change
// from elsewhere (an agent, a scan, another window) clears it so undo never reverts that.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), loading: vi.fn(), message: vi.fn() }) }));

class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  sent: { type: string; [key: string]: unknown }[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const store = new Map<string, string>();

beforeAll(() => {
  vi.useFakeTimers();
  const g = globalThis as Record<string, unknown>;
  g.WebSocket = FakeSocket;
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  g.window = {
    location: { protocol: "http:", host: "127.0.0.1:4177", search: "", origin: "http://127.0.0.1:4177" },
    localStorage: g.localStorage,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  };
  g.document = { visibilityState: "visible", addEventListener: () => {}, hasFocus: () => true, querySelectorAll: () => [] };
  g.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), headers: { get: () => "application/json" } });
});

afterAll(() => {
  vi.useRealTimers();
});

const ARCH = {
  version: 1,
  name: "shop",
  nodes: [
    { id: "api", name: "API", type: "service" },
    { id: "staging", name: "staging", type: "cluster" },
    { id: "staging-web", name: "web", type: "container", parent: "staging" },
    { id: "staging-db", name: "db", type: "database", parent: "staging" },
  ],
  edges: [{ from: "api", to: "staging-db", kind: "calls" }],
  workflows: [],
};

type Arch = typeof ARCH;
const ids = (a: { nodes: { id: string }[] } | null | undefined) => (a?.nodes ?? []).map((n) => n.id);

describe("map edit undo", () => {
  it("undoes and redoes the viewer's own edits, and forgets them when the map changes elsewhere", async () => {
    const daemon = await import("../src/lib/daemon");
    const edit = await import("../src/lib/architecture-edit");
    daemon.startDaemon();
    const ws = FakeSocket.instances.at(-1)!;
    ws.open();
    const frame = (architecture: Arch, extra: Record<string, unknown> = {}) =>
      ws.receive({ type: "architecture", reason: "initial", revision: 1, root: "/work/shop", path: "/work/shop/architecture.json", architecture, ...extra });
    ws.receive({ type: "project", project: { id: "abc123abc123", name: "shop", root: "/work/shop", kind: "repo", lastOpenedAt: "2026-09-26T00:00:00.000Z" } });
    frame(ARCH);
    expect(daemon.canEdit()).toBe(true);
    const saves = () => ws.sent.filter((m) => m.type === "architecture.save").map((m) => ids(m.architecture as Arch));

    // Delete "staging" with the two elements inside it.
    expect(daemon.editArchitecture((a) => edit.deleteNode(a, "arch:root", "staging"))).toBe(true);
    expect(ids(daemon.daemonSnapshot().architecture)).toEqual(["api"]);
    expect(daemon.daemonSnapshot().undoDepth).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(saves().at(-1)).toEqual(["api"]);
    // The echo of our own save keeps the history.
    frame({ ...ARCH, nodes: [ARCH.nodes[0]!], edges: [] }, { reason: "saved", revision: 2, by: { kind: "user" } });
    expect(daemon.daemonSnapshot().undoDepth).toBe(1);

    // ⌘Z brings it all back and saves that; ⇧⌘Z deletes it again.
    expect(daemon.undoEdit()).toBe(true);
    expect(ids(daemon.daemonSnapshot().architecture)).toEqual(["api", "staging", "staging-web", "staging-db"]);
    expect(daemon.daemonSnapshot()).toMatchObject({ undoDepth: 0, redoDepth: 1 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(saves().at(-1)).toEqual(["api", "staging", "staging-web", "staging-db"]);
    frame(ARCH, { reason: "saved", revision: 3, by: { kind: "user" } });
    expect(daemon.undoEdit()).toBe(false);
    expect(daemon.redoEdit()).toBe(true);
    expect(ids(daemon.daemonSnapshot().architecture)).toEqual(["api"]);
    expect(daemon.undoEdit()).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    frame(ARCH, { reason: "saved", revision: 4, by: { kind: "user" } });

    // A drag (many moves of one element) is one step.
    for (let x = 0; x < 5; x++) daemon.editArchitecture((a) => edit.patchNode(a, "arch:root", "api", { x: x * 8, y: 0 }), { coalesce: "node:api:x,y" });
    expect(daemon.daemonSnapshot().undoDepth).toBe(1);
    expect(daemon.undoEdit()).toBe(true);
    expect(daemon.daemonSnapshot().architecture?.nodes.find((n) => n.id === "api")).toEqual(ARCH.nodes[0]);
    await vi.advanceTimersByTimeAsync(2000);
    frame(ARCH, { reason: "saved", revision: 5, by: { kind: "user" } });

    // An agent's edit arrives: undoing past it would revert it, so the history is gone.
    daemon.editArchitecture((a) => edit.deleteNode(a, "arch:root", "api"));
    await vi.advanceTimersByTimeAsync(2000);
    frame({ ...ARCH, nodes: ARCH.nodes.slice(1), edges: [] }, { reason: "saved", revision: 6, by: { kind: "user" } });
    expect(daemon.daemonSnapshot().undoDepth).toBe(1);
    frame({ ...ARCH, nodes: ARCH.nodes.slice(2), edges: [] }, { reason: "saved", revision: 7, by: { kind: "agent", agentId: "claude", turnId: "t1" } });
    expect(daemon.daemonSnapshot()).toMatchObject({ undoDepth: 0, redoDepth: 0 });
    expect(daemon.undoEdit()).toBe(false);
    expect(ids(daemon.daemonSnapshot().architecture)).toEqual(["staging-web", "staging-db"]);
  });
});
