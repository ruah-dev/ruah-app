// Regression (§20.5): "Explore the sample" (the viewer shows the bundled sample while no daemon
// answers) must never touch real data. Before: when the daemon came up in the launcher state the
// sample map stayed on screen as if it were the daemon's (editable, saved to the daemon), and the
// engine buttons (Guard scan, Optimize, eval, replays) called whatever daemon served the page — its
// real open project — while the sample was on screen.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  sent: unknown[] = [];
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

const fetched: string[] = [];
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
    return { ok: true, status: 200, json: async () => ({}), headers: { get: () => "application/json" } };
  };
});

afterAll(() => {
  vi.useRealTimers();
});

describe("the bundled sample never reaches a daemon", () => {
  it("engine calls stay local in sample mode; a daemon that comes up drops the sample", async () => {
    const daemon = await import("../src/lib/daemon");
    const engines = await import("../src/lib/engines");
    daemon.startDaemon();
    // No answer within the first attempt: the sample is shown.
    await vi.advanceTimersByTimeAsync(3000);
    const sample = daemon.daemonSnapshot();
    expect(sample.source).toBe("sample");
    expect(sample.architecture?.nodes.length).toBeGreaterThan(0);

    // Guard scan, Optimize, eval, replay: refused with the reason, nothing fetched.
    fetched.length = 0;
    expect(engines.engineUrl("/api/engines/status")).toBeUndefined();
    expect(await engines.guardScan()).toEqual({ error: daemon.SAMPLE_MODE_MESSAGE });
    expect(await engines.optUsage()).toEqual({ error: daemon.SAMPLE_MODE_MESSAGE });
    expect(await engines.runEval("api", "hi")).toEqual({ error: daemon.SAMPLE_MODE_MESSAGE });
    expect(await engines.engineStatus()).toEqual({});
    expect(await engines.detectConv("api")).toEqual({ specs: [] });
    expect(fetched).toEqual([]);
    // Nothing that saves either (projects API).
    await expect(daemon.setScanOptions({ infra: false })).rejects.toThrow(/exploring the sample/);
    expect(fetched).toEqual([]);

    // The daemon comes up in the launcher state (no project): the sample map goes, it is not the daemon's.
    const ws = FakeSocket.instances.at(-1)!;
    ws.open();
    ws.receive({ type: "project", project: null });
    const after = daemon.daemonSnapshot();
    expect(after.source).toBe("daemon");
    expect(after.architecture).toBeNull();
    expect(after.turns).toEqual([]);
    expect(daemon.canEdit(after)).toBe(false);
    expect(engines.engineUrl("/api/engines/status")).toBe("http://127.0.0.1:4177/api/engines/status");
  });
});
