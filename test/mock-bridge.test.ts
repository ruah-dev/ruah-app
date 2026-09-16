import { describe, expect, test } from "vitest";
import { MockBridge } from "../src/acp/mock-bridge.js";
import type { BridgeEvent } from "../src/acp/bridge.js";
import type { ContentBlock } from "@agentclientprotocol/sdk";

function blocks(file: string): ContentBlock[] {
  return [
    { type: "text", text: "[archmap context]\nnode: invoices-api (service) id=api\n[/archmap context]" },
    { type: "resource_link", uri: "file:///repo/services/app.ts", name: file },
  ];
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("scripted turn: status busy, chunks, read tool, edit + permission, diff, end_turn", async () => {
  const bridge = new MockBridge({ root: "/repo", preset: { command: "none", args: [] }, clientVersion: "0" });
  const events: BridgeEvent[] = [];
  bridge.on((e) => events.push(e));
  await bridge.start();
  expect(bridge.status()).toBe("idle");

  const handle = bridge.prompt("turn-1", blocks("services/app.ts"));
  await until(() => events.some((e) => e.type === "permission"));
  bridge.answerPermission("perm_turn-1", { optionId: "allow" });
  const result = await handle.done;

  expect(result.stopReason).toBe("end_turn");
  const kinds = events.map((e) => e.type);
  expect(kinds.filter((k) => k === "stream").length).toBeGreaterThan(6);

  const streams = events.filter((e) => e.type === "stream");
  const textChunks = streams.filter((e) => e.type === "stream" && e.event.kind === "text");
  expect(textChunks.length).toBe(8); // 6 before + 2 after the permission

  const read = streams.find((e) => e.type === "stream" && e.event.kind === "tool_call");
  expect(read && read.type === "stream" && read.event.kind === "tool_call" && read.event.toolCall.kind).toBe("read");

  const perm = events.find((e) => e.type === "permission");
  expect(perm && perm.type === "permission" && perm.options.map((o) => o.optionId)).toEqual([
    "allow",
    "allow_always",
    "reject",
  ]);

  const resolved = events.find((e) => e.type === "permission_resolved");
  expect(resolved && resolved.type === "permission_resolved" && resolved.optionId).toBe("allow");

  const diff = streams.find((e) => e.type === "stream" && e.event.kind === "diff");
  expect(diff).toBeDefined();

  const finished = events.find((e) => e.type === "turn_finished");
  expect(finished && finished.type === "turn_finished" && finished.stopReason).toBe("end_turn");

  const lastStatus = events.filter((e) => e.type === "status").at(-1);
  expect(lastStatus && lastStatus.type === "status" && lastStatus.state).toBe("idle");
}, 15000);

test("rejected permission produces failed tool_result", async () => {
  const bridge = new MockBridge({ root: "/repo", preset: { command: "none", args: [] }, clientVersion: "0" });
  const events: BridgeEvent[] = [];
  bridge.on((e) => events.push(e));
  await bridge.start();
  const handle = bridge.prompt("t", blocks("a.ts"));
  await until(() => events.some((e) => e.type === "permission"));
  expect(bridge.answerPermission("perm_t", { optionId: "reject" })).toBe(true);
  const result = await handle.done;
  expect(result.stopReason).toBe("end_turn");
  const failed = events.find(
    (e) => e.type === "stream" && e.event.kind === "tool_result" && e.event.toolCall.status === "failed",
  );
  expect(failed).toBeDefined();
}, 15000);

test("answerPermission with unknown requestId returns false", async () => {
  const bridge = new MockBridge({ root: "/repo", preset: { command: "none", args: [] }, clientVersion: "0" });
  bridge.on(() => {});
  await bridge.start();
  bridge.prompt("t", blocks("a.ts"));
  expect(bridge.answerPermission("unknown", { optionId: "allow" })).toBe(false);
  await bridge.cancel("t");
});

test("cancel finishes with stopReason cancelled within 100 ms", async () => {
  const bridge = new MockBridge({ root: "/repo", preset: { command: "none", args: [] }, clientVersion: "0" });
  const events: BridgeEvent[] = [];
  bridge.on((e) => events.push(e));
  await bridge.start();
  const handle = bridge.prompt("t", blocks("a.ts"));
  const t0 = Date.now();
  await bridge.cancel("t");
  const result = await handle.done;
  expect(result.stopReason).toBe("cancelled");
  expect(Date.now() - t0).toBeLessThan(100);
}, 15000);

test("second prompt while busy throws BusyError", async () => {
  const bridge = new MockBridge({ root: "/repo", preset: { command: "none", args: [] }, clientVersion: "0" });
  bridge.on(() => {});
  await bridge.start();
  bridge.prompt("t1", blocks("a.ts"));
  expect(() => bridge.prompt("t2", blocks("a.ts"))).toThrow(/turn is already active/);
  await bridge.cancel("t1");
});
