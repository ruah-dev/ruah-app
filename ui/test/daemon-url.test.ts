// Regression: a viewer opened with `?daemon=ws://host:port/ws` (a viewer served from another
// origin) reconnected to its own host after the first in-app navigation — the router drops the
// query — so a daemon that restarted, or came up after the sample was shown, was never found again.
import { beforeAll, describe, expect, it } from "vitest";

const location = { protocol: "http:", host: "127.0.0.1:4392", search: "?daemon=ws://127.0.0.1:4393/ws", origin: "http://127.0.0.1:4392" };

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  const store = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  g.window = { location, localStorage: g.localStorage, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true };
  g.document = { visibilityState: "visible", addEventListener: () => {}, hasFocus: () => true };
});

describe("the daemon a page was opened for", () => {
  it("survives navigations that drop ?daemon=", async () => {
    const { resolveDaemonUrls } = await import("../src/lib/daemon");
    expect(resolveDaemonUrls()).toEqual({ wsUrl: "ws://127.0.0.1:4393/ws", httpOrigin: "http://127.0.0.1:4393" });
    // The router navigated to /usage: no query any more.
    location.search = "";
    expect(resolveDaemonUrls()).toEqual({ wsUrl: "ws://127.0.0.1:4393/ws", httpOrigin: "http://127.0.0.1:4393" });
    // A page that names another daemon later wins.
    location.search = "?daemon=ws://127.0.0.1:4500/ws";
    expect(resolveDaemonUrls()?.httpOrigin).toBe("http://127.0.0.1:4500");
  });
});
