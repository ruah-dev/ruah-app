// test/bridge.test.ts — AcpProcessBridge against test/fake-agent.ts, spawned as
// a real child process (node --import tsx) over stdio, exactly like a preset.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { AcpProcessBridge, type AcpBridgeTuning } from "../src/acp/acp-bridge.js";
import { BusyError, type AcpPreset, type BridgeEvent } from "../src/acp/bridge.js";
import type { StreamEvent } from "../src/contracts/ws.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

function fakePreset(env?: Record<string, string>): AcpPreset {
  return { command: process.execPath, args: ["--import", tsxLoader, path.join(here, "fake-agent.ts")], ...(env !== undefined ? { env } : {}) };
}

class Harness {
  readonly events: BridgeEvent[] = [];
  stderr = "";
  readonly bridge: AcpProcessBridge;
  private waiters: { pred: (e: BridgeEvent) => boolean; resolve: (e: BridgeEvent) => void }[] = [];

  constructor(tuning: AcpBridgeTuning = {}, env?: Record<string, string>) {
    this.bridge = new AcpProcessBridge(
      { root, preset: fakePreset(env), clientVersion: "0.0.0-test", onStderr: (c) => { this.stderr += c; } },
      { killGraceMs: 200, ...tuning },
    );
    this.bridge.on((e) => {
      this.events.push(e);
      this.waiters = this.waiters.filter((w) => {
        if (!w.pred(e)) return true;
        w.resolve(e);
        return false;
      });
    });
  }

  /** Resolves with the first event (after index `from`) matching `pred`. */
  waitFor(pred: (e: BridgeEvent) => boolean, from = 0, timeoutMs = 10_000): Promise<BridgeEvent> {
    const seen = this.events.slice(from).find(pred);
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for bridge event")), timeoutMs);
      this.waiters.push({ pred, resolve: (e) => { clearTimeout(timer); resolve(e); } });
    });
  }

  streams(turnId: string): StreamEvent[] {
    return this.events.flatMap((e) => (e.type === "stream" && e.turnId === turnId ? [e.event] : []));
  }

  statuses(from = 0): string[] {
    return this.events.slice(from).flatMap((e) => (e.type === "status" ? [e.state] : []));
  }
}

const text = (t: string): ContentBlock[] => [{ type: "text", text: t }];
const isStatus = (state: string) => (e: BridgeEvent): boolean => e.type === "status" && e.state === state;

let current: Harness | undefined;
async function started(tuning?: AcpBridgeTuning, env?: Record<string, string>): Promise<Harness> {
  const h = new Harness(tuning, env);
  current = h;
  await h.bridge.start();
  return h;
}

afterEach(async () => {
  await current?.bridge.stop();
  current = undefined;
});

describe("AcpProcessBridge", () => {
  it("start: starting → idle with agent info, session id and modes", async () => {
    const h = await started();
    expect(h.bridge.status()).toBe("idle");
    expect(h.statuses()).toEqual(["starting", "idle"]);
    const idle = h.events.at(-1);
    expect(idle).toMatchObject({
      type: "status",
      state: "idle",
      agent: { name: "fake-agent", version: "0.0.1" },
      sessionId: "fake-session-1",
      modes: {
        currentModeId: "default",
        available: [
          { id: "default", name: "Manual", description: "Ask first" },
          { id: "plan", name: "Plan" },
        ],
      },
    });
    expect(h.stderr).toContain(`cwd=${root}`);
  });

  it("streams text chunks and finishes with end_turn", async () => {
    const h = await started();
    const from = h.events.length;
    const handle = h.bridge.prompt("t1", text("text"));
    expect(h.bridge.status()).toBe("busy");
    expect(await handle.done).toEqual({ stopReason: "end_turn" });
    // Leading whitespace-only chunk dropped (no open segment); inner " " kept.
    expect(h.streams("t1")).toEqual([
      { kind: "text", text: "Hello" },
      { kind: "text", text: " " },
      { kind: "text", text: "world" },
    ]);
    expect(h.statuses(from)).toEqual(["busy", "idle"]);
    expect(h.events.find((e) => e.type === "turn_finished")).toEqual({ type: "turn_finished", turnId: "t1", stopReason: "end_turn" });
  });

  it("relativizes tool locations and caps output at 4096 chars", async () => {
    const h = await started();
    await h.bridge.prompt("t1", text("tool")).done;
    const [call, result, after] = h.streams("t1");
    expect(call).toEqual({
      kind: "tool_call",
      toolCall: {
        toolCallId: "tc_read",
        title: "Read src/a.ts",
        kind: "read",
        status: "in_progress",
        locations: [{ path: "src/a.ts", line: 1 }, { path: "/etc/hosts" }],
      },
    });
    expect(result?.kind).toBe("tool_result");
    if (result?.kind !== "tool_result") throw new Error("expected tool_result");
    expect(result.toolCall.status).toBe("completed");
    expect(result.toolCall.locations).toEqual([{ path: "src/a.ts", line: 1 }, { path: "/etc/hosts" }]);
    expect(result.toolCall.output).toBe(`${"x".repeat(4096)} …[truncated]`);
    expect(after).toEqual({ kind: "text", text: "Read it." });
  });

  it("permission allow: relays options verbatim, emits diff once and a completed tool_result", async () => {
    const h = await started();
    const handle = h.bridge.prompt("t1", text("permission"));
    const perm = await h.waitFor((e) => e.type === "permission");
    if (perm.type !== "permission") throw new Error("unreachable");
    expect(perm.turnId).toBe("t1");
    expect(perm.options).toEqual([
      { optionId: "opt-allow", name: "Allow", kind: "allow_once" },
      { optionId: "opt-always", name: "Always allow", kind: "allow_always" },
      { optionId: "opt-reject", name: "Reject", kind: "reject_once" },
    ]);
    // Merged with the earlier tool_call: locations survive the partial permission toolCall.
    expect(perm.toolCall).toEqual({
      toolCallId: "tc_edit",
      title: "Edit src/edit.ts",
      kind: "edit",
      status: "pending",
      locations: [{ path: "src/edit.ts", line: 3 }],
    });
    expect(h.bridge.answerPermission("perm_nope", { optionId: "opt-allow" })).toBe(false);
    expect(h.bridge.answerPermission(perm.requestId, { optionId: "made-up" })).toBe(false);
    expect(h.bridge.answerPermission(perm.requestId, { optionId: "opt-allow" })).toBe(true);
    expect(h.bridge.answerPermission(perm.requestId, { optionId: "opt-allow" })).toBe(false);
    expect(await handle.done).toEqual({ stopReason: "end_turn" });
    expect(h.events).toContainEqual({ type: "permission_resolved", turnId: "t1", requestId: perm.requestId, optionId: "opt-allow" });
    const streams = h.streams("t1");
    expect(streams.filter((s) => s.kind === "diff")).toEqual([
      { kind: "diff", toolCallId: "tc_edit", path: "src/edit.ts", oldText: "a", newText: "b" },
    ]);
    expect(streams).toContainEqual({
      kind: "tool_result",
      toolCall: { toolCallId: "tc_edit", title: "Edit src/edit.ts", kind: "edit", status: "completed", locations: [{ path: "src/edit.ts", line: 3 }] },
    });
    expect(h.stderr).toContain("permission outcome=selected:opt-allow");
  });

  it("permission reject: failed tool_result", async () => {
    const h = await started();
    const handle = h.bridge.prompt("t1", text("permission"));
    const perm = await h.waitFor((e) => e.type === "permission");
    if (perm.type !== "permission") throw new Error("unreachable");
    expect(h.bridge.answerPermission(perm.requestId, { optionId: "opt-reject" })).toBe(true);
    expect(await handle.done).toEqual({ stopReason: "end_turn" });
    const result = h.streams("t1").find((s) => s.kind === "tool_result");
    expect(result).toMatchObject({ kind: "tool_result", toolCall: { toolCallId: "tc_edit", status: "failed" } });
  });

  it("cancel mid-permission: answers the permission as cancelled before session/cancel", async () => {
    const h = await started();
    const handle = h.bridge.prompt("t1", text("permission"));
    const perm = await h.waitFor((e) => e.type === "permission");
    if (perm.type !== "permission") throw new Error("unreachable");
    const t0 = Date.now();
    await h.bridge.cancel("t1");
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(await handle.done).toEqual({ stopReason: "cancelled" });
    expect(h.events).toContainEqual({ type: "permission_resolved", turnId: "t1", requestId: perm.requestId, cancelled: true });
    // Wire order as seen by the agent: the cancelled outcome arrives before session/cancel.
    const permLine = h.stderr.indexOf(`recv response {"outcome":{"outcome":"cancelled"}}`);
    const cancelLine = h.stderr.indexOf("recv session/cancel");
    expect(permLine).toBeGreaterThanOrEqual(0);
    expect(cancelLine).toBeGreaterThan(permLine);
    expect(h.bridge.answerPermission(perm.requestId, { cancelled: true })).toBe(false);
    expect(h.bridge.status()).toBe("idle");
  });

  it("throws BusyError while a turn is active; cancel of another turnId is a no-op", async () => {
    const h = await started();
    const handle = h.bridge.prompt("t1", text("slow"));
    expect(() => h.bridge.prompt("t2", text("text"))).toThrow(BusyError);
    await h.waitFor((e) => e.type === "stream" && e.turnId === "t1");
    await h.bridge.cancel("not-the-turn");
    expect(h.bridge.status()).toBe("busy");
    await h.bridge.cancel("t1");
    expect(await handle.done).toEqual({ stopReason: "cancelled" });
    // Next prompt works after cancel.
    expect(await h.bridge.prompt("t3", text("text")).done).toEqual({ stopReason: "end_turn" });
  });

  it("setMode sends session/set_mode and reports the new mode", async () => {
    const h = await started();
    const from = h.events.length;
    await h.bridge.setMode("plan");
    const status = await h.waitFor((e) => e.type === "status" && e.modes?.currentModeId === "plan", from);
    expect(status).toMatchObject({ state: "idle", modes: { currentModeId: "plan" } });
    expect(h.stderr).toContain("set_mode plan");
  });

  it("start: reports the model config option as models", async () => {
    const h = await started();
    expect(h.events.at(-1)).toMatchObject({
      type: "status",
      state: "idle",
      models: {
        currentModelId: "default",
        available: [
          { id: "default", name: "Default (recommended)", description: "Opus" },
          { id: "sonnet", name: "Sonnet" },
          { id: "haiku", name: "Haiku", description: "Fastest" },
        ],
      },
    });
  });

  it("setModel sends session/set_config_option and reports the new model; unknown ids are rejected", async () => {
    const h = await started();
    const from = h.events.length;
    await h.bridge.setModel("haiku");
    expect(h.stderr).toContain("set_config_option fake-session-1 model=haiku");
    const status = await h.waitFor((e) => e.type === "status" && e.models?.currentModelId === "haiku", from);
    expect(status).toMatchObject({ state: "idle", models: { currentModelId: "haiku" } });
    await expect(h.bridge.setModel("gpt-9")).rejects.toThrow(/unknown model/);
    // Selecting the current model is a no-op on the wire.
    await h.bridge.setModel("haiku");
    expect(h.stderr.match(/set_config_option fake-/g)).toHaveLength(1);
  });

  it("follows config_option_update from the agent", async () => {
    const h = await started();
    await h.bridge.prompt("t1", text("automodel")).done;
    const status = h.events.find((e) => e.type === "status" && e.models?.currentModelId === "haiku");
    expect(status).toMatchObject({ state: "busy" });
  });

  it("re-applies the chosen model after reset and after a crash respawn", async () => {
    const h = await started();
    await h.bridge.setModel("sonnet");
    await h.bridge.reset();
    expect(h.stderr).toContain("set_config_option fake-session-2 model=sonnet");
    expect(h.events.at(-1)).toMatchObject({ type: "status", state: "idle", sessionId: "fake-session-2", models: { currentModelId: "sonnet" } });

    const from = h.events.length;
    await h.bridge.prompt("t1", text("crash")).done;
    const err = await h.waitFor(isStatus("error"), from);
    const idle = await h.waitFor(isStatus("idle"), h.events.indexOf(err));
    // New process: its first session gets the model again.
    expect(idle).toMatchObject({ sessionId: "fake-session-1", models: { currentModelId: "sonnet" } });
    expect(h.stderr).toContain("set_config_option fake-session-1 model=sonnet");
  });

  it("modes offered only as a config option: reported and switched via session/set_config_option", async () => {
    const h = await started({}, { FAKE_AGENT_CONFIG_MODES: "1" });
    expect(h.events.at(-1)).toMatchObject({
      state: "idle",
      modes: { currentModeId: "default", available: [{ id: "default", name: "Manual" }, { id: "plan", name: "Plan" }] },
    });
    await h.bridge.setMode("plan");
    expect(h.stderr).toContain("set_config_option fake-session-1 mode=plan");
    expect(h.stderr).not.toContain("set_mode");
    expect(h.events.at(-1)).toMatchObject({ state: "idle", modes: { currentModeId: "plan" } });
  });

  it("reset opens a new session in the same process", async () => {
    const h = await started();
    await h.bridge.reset();
    const idle = h.events.at(-1);
    expect(idle).toMatchObject({ type: "status", state: "idle", sessionId: "fake-session-2" });
    expect(h.stderr).toContain("session/new fake-session-2");
    expect(await h.bridge.prompt("t1", text("text")).done).toEqual({ stopReason: "end_turn" });
  });

  it("ignores extension notifications, foreign sessions and replays; forwards plan", async () => {
    const h = await started();
    await h.bridge.prompt("t1", text("extras")).done;
    expect(h.streams("t1")).toEqual([
      { kind: "plan", entries: [{ content: "Look", priority: "high", status: "in_progress" }] },
      { kind: "text", text: "ok" },
    ]);
  });

  it("agent crash mid-turn: turn_finished error, status error, then respawns once", async () => {
    const h = await started();
    const from = h.events.length;
    const handle = h.bridge.prompt("t1", text("crash"));
    const result = await handle.done;
    expect(result.stopReason).toBe("error");
    expect(result.error).toMatch(/agent exited \(code 3/);
    const err = await h.waitFor(isStatus("error"), from);
    expect(err).toMatchObject({ type: "status", state: "error" });
    await h.waitFor(isStatus("idle"), h.events.indexOf(err));
    expect(h.statuses(from)).toEqual(["busy", "error", "starting", "idle"]);
    const finishedAt = h.events.findIndex((e) => e.type === "turn_finished");
    expect(finishedAt).toBeLessThan(h.events.indexOf(err));
    expect(await h.bridge.prompt("t2", text("text")).done).toEqual({ stopReason: "end_turn" });
  });

  it("cancel timeout: kills and respawns the agent, finishes the turn with error", async () => {
    const h = await started({ cancelTimeoutMs: 300 });
    const handle = h.bridge.prompt("t1", text("hang"));
    await h.waitFor((e) => e.type === "permission");
    const from = h.events.length;
    await h.bridge.cancel("t1");
    const result = await handle.done;
    expect(result.stopReason).toBe("error");
    expect(result.error).toMatch(/did not finish cancellation/);
    expect(h.statuses(from)).toEqual(["error", "starting", "idle"]);
    expect(h.bridge.status()).toBe("idle");
  });

  it("stop terminates the agent", async () => {
    const h = await started();
    await h.bridge.stop();
    expect(h.bridge.status()).toBe("stopped");
    expect(h.events.at(-1)).toEqual({ type: "status", state: "stopped" });
  });

  it("start failure (bad command) reports status error and rejects", async () => {
    const bridge = new AcpProcessBridge({ root, preset: { command: "/nonexistent/agent", args: [] }, clientVersion: "0" });
    const states: string[] = [];
    bridge.on((e) => {
      if (e.type === "status") states.push(e.state);
    });
    await expect(bridge.start()).rejects.toThrow(/agent failed to start/);
    expect(bridge.status()).toBe("error");
    expect(states).toEqual(["starting", "error"]);
  });
});
