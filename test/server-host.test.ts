// DNS-rebinding guard: requests whose Host names a domain the daemon was not
// told about are refused before any route (GETs carry no Origin header, so the
// Origin check alone let a rebound page read /api/file, /api/architecture, …).
import * as http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { hostAllowed, startServer } from "../src/serve/server.js";
import { SessionHub } from "../src/serve/session.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function get(url: string, path: string, host: string): Promise<number> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path, method: "GET", headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("Host check", () => {
  it("allows loopback names, IP literals, the bind host and --allow-origin hosts", () => {
    expect(hostAllowed(undefined, "127.0.0.1", [])).toBe(true);
    expect(hostAllowed("127.0.0.1:4177", "127.0.0.1", [])).toBe(true);
    expect(hostAllowed("localhost:4177", "127.0.0.1", [])).toBe(true);
    expect(hostAllowed("[::1]:4177", "127.0.0.1", [])).toBe(true);
    expect(hostAllowed("192.168.1.20:4177", "0.0.0.0", [])).toBe(true);
    expect(hostAllowed("devbox.lan:4177", "devbox.lan", [])).toBe(true);
    expect(hostAllowed("ruah.example.dev", "127.0.0.1", ["https://*.example.dev"])).toBe(true);
    expect(hostAllowed("evil.example:4177", "127.0.0.1", [])).toBe(false);
    expect(hostAllowed("evil.example:4177", "127.0.0.1", ["https://*.lovable.app"])).toBe(false);
  });

  it("refuses a rebound host on GET routes and websocket upgrades", async () => {
    const hub = new SessionHub(null, null, { version: "0.0.0-test", links: false, debug: () => {}, info: () => {} });
    const server = await startServer(null, hub, { host: "127.0.0.1", port: 0, allowOrigins: [], logger: () => {} });
    cleanups.push(async () => {
      await hub.shutdown();
      await server.close();
    });
    const port = new URL(server.url).port;
    expect(await get(server.url, "/api/health", `127.0.0.1:${port}`)).toBe(200);
    expect(await get(server.url, "/api/health", `evil.example:${port}`)).toBe(403);
    expect(await get(server.url, "/api/file?path=README.md", `evil.example:${port}`)).toBe(403);
    const upgrade = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/ws",
        headers: { host: `evil.example:${port}`, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
      });
      req.on("response", (res) => resolve(res.statusCode ?? 0));
      req.on("upgrade", () => resolve(101));
      req.on("error", reject);
      req.end();
    });
    expect(upgrade).toBe(403);
  });
});
