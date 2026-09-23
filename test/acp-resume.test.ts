// test/acp-resume.test.ts — AcpProcessBridge.useSession against
// test/fake-agent.ts: session/load when the agent advertises loadSession
// (history replay not forwarded), a new session otherwise, and a choice made
// on a stopped bridge applied by start().
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AcpProcessBridge } from "../src/acp/acp-bridge.js";
import type { BridgeEvent } from "../src/acp/bridge.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

interface Harness {
  bridge: AcpProcessBridge;
  events: BridgeEvent[];
  stderr: () => string;
}

const bridges: AcpProcessBridge[] = [];
afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.stop();
});

function harness(env: Record<string, string>): Harness {
  let stderr = "";
  const bridge = new AcpProcessBridge(
    {
      root,
      preset: { command: process.execPath, args: ["--import", tsxLoader, path.join(here, "fake-agent.ts")], env },
      clientVersion: "0.0.0-test",
      onStderr: (chunk) => {
        stderr += chunk;
      },
    },
    { killGraceMs: 200 },
  );
  bridges.push(bridge);
  const events: BridgeEvent[] = [];
  bridge.on((event) => events.push(event));
  return { bridge, events, stderr: () => stderr };
}

const lastSessionId = (events: BridgeEvent[]): string | undefined =>
  events.flatMap((e) => (e.type === "status" && e.state === "idle" && e.sessionId !== undefined ? [e.sessionId] : [])).at(-1);

describe("AcpProcessBridge.useSession", () => {
  it("loads a stored session with session/load when the agent supports it", async () => {
    const h = harness({ FAKE_AGENT_LOAD_SESSION: "1" });
    await h.bridge.start();
    expect(lastSessionId(h.events)).toBe("fake-session-1");
    await h.bridge.useSession(undefined);
    expect(lastSessionId(h.events)).toBe("fake-session-2");
    await h.bridge.useSession("fake-session-1");
    expect(h.stderr()).toContain(`session/load fake-session-1 cwd=${root}`);
    expect(lastSessionId(h.events)).toBe("fake-session-1");
    expect(h.bridge.status()).toBe("idle");
    // Models come from the load response; the replayed history is not a stream event.
    expect(h.events.at(-1)).toMatchObject({ type: "status", state: "idle", models: { currentModelId: "default" } });
    const result = await h.bridge.prompt("t1", [{ type: "text", text: "text" }]).done;
    expect(result.stopReason).toBe("end_turn");
    const texts = h.events.flatMap((e) => (e.type === "stream" && e.event.kind === "text" ? [e.event.text] : []));
    expect(texts.join("")).not.toContain("replayed history");
    expect(texts.join("")).toContain("Hello");
  }, 20_000);

  it("opens a new session when the agent cannot load sessions", async () => {
    const h = harness({});
    await h.bridge.start();
    await h.bridge.useSession("stored-elsewhere");
    expect(h.stderr()).not.toContain("session/load");
    expect(lastSessionId(h.events)).toBe("fake-session-2");
  }, 20_000);

  it("a choice made on a stopped bridge is applied by start()", async () => {
    const h = harness({ FAKE_AGENT_LOAD_SESSION: "1" });
    await h.bridge.useSession("persisted-7");
    expect(h.bridge.status()).toBe("stopped");
    await h.bridge.start();
    expect(h.stderr()).toContain("session/load persisted-7");
    expect(h.stderr()).not.toContain("session/new");
    expect(lastSessionId(h.events)).toBe("persisted-7");
  }, 20_000);
});
