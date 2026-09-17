import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "./store.js";

// Drives the CONTRACTS.md §2.4 turn sequence through the real DaemonSocket +
// store, against a scripted fake WebSocket. Verifies the viewer-side state
// machine: text segmentation, tool upserts, permission block/answer, cancel.

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static last(): FakeWebSocket {
    const ws = FakeWebSocket.instances.at(-1);
    if (ws === undefined) throw new Error("no socket");
    return ws;
  }

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.onclose?.();
  }

  // test helpers
  serverOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  serverFrame(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

const TURN = "3f1c1c2e-8a7b-4a53-9a1a-5d1c0f0b7e11";

function daemonArch() {
  return {
    type: "architecture",
    reason: "initial",
    revision: 3,
    root: "/tmp/acme",
    path: "/tmp/acme/architecture.json",
    architecture: {
      version: 1 as const,
      name: "acme-platform",
      nodes: [{ id: "api", type: "service", name: "invoices-api" }],
      edges: [],
      workflows: [],
    },
  };
}

describe("store turn machine over a scripted socket", () => {
  beforeEach(() => {
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    FakeWebSocket.instances = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends hello as the first frame after open", () => {
    const store = createStore("ws://127.0.0.1:4177/ws");
    store.connect();
    const ws = FakeWebSocket.last();
    ws.serverOpen();
    const hello = ws.sent[0];
    expect(hello).toBeDefined();
    const parsed: unknown = JSON.parse(hello ?? "{}");
    expect(parsed).toMatchObject({ type: "hello", protocol: 1 });
    store.close();
  });

  it("runs the §2.4 sequence: started, text, tools, permission, diff, finished", () => {
    const store = createStore("ws://127.0.0.1:4177/ws");
    store.connect();
    const ws = FakeWebSocket.last();
    ws.serverOpen();
    ws.serverFrame(daemonArch());
    ws.serverFrame({ type: "agent.status", state: "idle" });

    expect(store.getState().connection).toBe("open");
    expect(store.getState().agent).toBe("idle");
    expect(store.getState().architecture?.name).toBe("acme-platform");

    store.send({ type: "prompt", turnId: TURN, nodeId: "api", text: "there might be a bug" });
    expect(ws.sent.at(-1)).toContain('"type":"prompt"');

    ws.serverFrame({ type: "turn.started", turnId: TURN, nodeId: "api", contextPack: "[archmap context]", text: "there might be a bug" });
    ws.serverFrame({ type: "stream", turnId: TURN, event: { kind: "text", text: "The enum rejected GBP. " } });
    ws.serverFrame({ type: "stream", turnId: TURN, event: { kind: "tool_call", toolCall: { toolCallId: "t1", title: "Read routes.ts", kind: "read", status: "in_progress", locations: [{ path: "src/routes.ts" }] } } });
    ws.serverFrame({ type: "stream", turnId: TURN, event: { kind: "tool_result", toolCall: { toolCallId: "t1", title: "Read routes.ts", kind: "read", status: "completed", locations: [{ path: "src/routes.ts" }], output: "export {}" } } });
    ws.serverFrame({ type: "permission.request", turnId: TURN, requestId: "perm_7", toolCall: { toolCallId: "t2", title: "Edit routes.ts", kind: "edit", status: "pending", locations: [{ path: "src/routes.ts", line: 12 }] }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] });

    let state = store.getState();
    expect(state.turns).toHaveLength(1);
    const turn = state.turns[0]!;
    expect(turn.toolCalls.get("t1")?.status).toBe("completed");
    expect(turn.permission?.requestId).toBe("perm_7");

    store.send({ type: "permission.response", requestId: "perm_7", optionId: "allow" });
    expect(ws.sent.at(-1)).toContain('"optionId":"allow"');

    ws.serverFrame({ type: "permission.resolved", turnId: TURN, requestId: "perm_7", optionId: "allow" });
    ws.serverFrame({ type: "stream", turnId: TURN, event: { kind: "diff", toolCallId: "t2", path: "src/routes.ts", oldText: "a", newText: "b" } });
    ws.serverFrame({ type: "turn.finished", turnId: TURN, stopReason: "end_turn" });

    state = store.getState();
    expect(state.turns[0]!.stopReason).toBe("end_turn");
    expect(state.turns[0]!.permission).toBeNull();
    expect(state.turns[0]!.permissionRecord).toContain("answered");
    expect(state.turns[0]!.events.some((e) => e.kind === "diff")).toBe(true);
    store.close();
  });

  it("cancel sends the cancel frame and records the stopReason", () => {
    const store = createStore("ws://127.0.0.1:4177/ws");
    store.connect();
    const ws = FakeWebSocket.last();
    ws.serverOpen();
    ws.serverFrame(daemonArch());
    ws.serverFrame({ type: "turn.started", turnId: TURN, nodeId: "api", contextPack: "pack", text: "go" });

    store.send({ type: "cancel", turnId: TURN });
    expect(ws.sent.at(-1)).toContain('"type":"cancel"');

    ws.serverFrame({ type: "turn.finished", turnId: TURN, stopReason: "cancelled" });
    expect(store.getState().turns[0]!.stopReason).toBe("cancelled");
    store.close();
  });

  it("focus.set rides along on selection", () => {
    const store = createStore("ws://127.0.0.1:4177/ws");
    store.connect();
    const ws = FakeWebSocket.last();
    ws.serverOpen();
    ws.serverFrame(daemonArch());
    store.send({ type: "focus.set", nodeId: "api" });
    expect(ws.sent.at(-1)).toContain('"type":"focus.set"');
    store.send({ type: "focus.set", nodeId: null });
    expect(ws.sent.at(-1)).toContain('"nodeId":null');
    store.close();
  });

  it("ignores frames that fail contract validation", () => {
    const store = createStore("ws://127.0.0.1:4177/ws");
    store.connect();
    const ws = FakeWebSocket.last();
    ws.serverOpen();
    ws.serverFrame({ type: "architecture", reason: "bogus-reason", revision: -1, root: "", path: "", architecture: { version: 2 } });
    expect(store.getState().architecture).toBeNull();
    store.close();
  });
});
