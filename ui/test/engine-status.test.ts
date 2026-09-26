// Regression: the Guard, Optimize and Replay cards read /api/engines/status once when they mounted.
// Mounted before the daemon answered (or while the sample was shown), they said "not installed"
// until a reload. They now ask again when the daemon connects (useEngineTool); every card on screen
// shares one read (a chat shows a replay button per turn), and a failed read is not remembered.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send() {}
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

const fetched: string[] = [];
let answer: { ok: boolean; body: unknown } = { ok: true, body: {} };
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
  g.document = { visibilityState: "visible", addEventListener: () => {}, hasFocus: () => true };
  g.fetch = async (url: string) => {
    fetched.push(String(url));
    const { ok, body } = answer;
    return { ok, status: ok ? 200 : 500, json: async () => body, headers: { get: () => "application/json" } };
  };
});

afterAll(() => {
  vi.useRealTimers();
});

describe("engine status for the Guard / Optimize / Replay cards", () => {
  it("one read shared by every card, a failed read asked again", async () => {
    const daemon = await import("../src/lib/daemon");
    const engines = await import("../src/lib/engines");
    daemon.startDaemon();
    await vi.advanceTimersByTimeAsync(3000);
    expect(await engines.engineStatus()).toEqual({});
    expect(fetched.filter((u) => u.includes("/api/engines/status"))).toEqual([]);

    const ws = FakeSocket.instances.at(-1)!;
    ws.open();
    ws.receive({ type: "project", project: null });

    // The daemon answers 500 once: nothing is remembered, the next card asks again.
    answer = { ok: false, body: { error: "boom" } };
    expect(await engines.engineStatus()).toEqual({});
    answer = { ok: true, body: { guard: { installed: true, install: "npm i -g @ruah-dev/cli @ruah-dev/guard" } } };
    const [a, b, c] = await Promise.all([engines.engineStatus(), engines.engineStatus(), engines.engineStatus()]);
    expect(a.guard?.installed).toBe(true);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(fetched.filter((u) => u.endsWith("/api/engines/status"))).toHaveLength(2);

    // Read again after a while (an engine installed meanwhile shows up without a reload).
    await vi.advanceTimersByTimeAsync(16_000);
    await engines.engineStatus();
    expect(fetched.filter((u) => u.endsWith("/api/engines/status"))).toHaveLength(3);
  });
});
