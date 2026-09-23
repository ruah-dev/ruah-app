// test/claude-sdk-bridge.test.ts — ClaudeSdkBridge against a fake query()
// (no Claude process): text streaming, tool call + permission allow/reject,
// cancel, BusyError, setMode, setModel, skill dispatch, CLI exit + resume.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

// Same lookup as the bridge: the package.json next to the SDK entry.
const SDK_VERSION = (JSON.parse(readFileSync(join(dirname(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk")), "package.json"), "utf8")) as { version: string }).version;
import type {
  CanUseTool,
  ModelInfo,
  Options,
  PermissionMode,
  PermissionResult,
  Query,
  SDKControlInitializeResponse,
  SDKMessage,
  SDKUserMessage,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import type { BridgeEvent } from "../src/acp/bridge.js";
import { BusyError } from "../src/acp/bridge.js";
import { ClaudeSdkBridge } from "../src/acp/claude-sdk-bridge.js";

const ROOT = "/tmp/archmap-fake-repo";
const SESSION = "11111111-2222-4333-8444-555555555555";
const MODELS: ModelInfo[] = [
  { value: "default", displayName: "Default (recommended)", description: "Opus 5.5 · Most capable", resolvedModel: "claude-opus-5-5" },
  { value: "sonnet", displayName: "Sonnet", description: "Sonnet 5 · Everyday tasks", resolvedModel: "claude-sonnet-5" },
  { value: "haiku", displayName: "Haiku", description: "", resolvedModel: "claude-haiku-4-5" },
];

class FakeQuery implements AsyncIterator<SDKMessage> {
  readonly received: SDKUserMessage[] = [];
  readonly modes: PermissionMode[] = [];
  readonly models: Array<string | undefined> = [];
  interrupts = 0;
  closed = false;
  onUserMessage: ((message: SDKUserMessage) => void) | undefined;
  onInterrupt: (() => void) | undefined;
  private readonly outbox: SDKMessage[] = [];
  private readonly waiters: Array<{ resolve: (result: IteratorResult<SDKMessage>) => void; reject: (error: Error) => void }> = [];
  private ended = false;
  private failure: Error | undefined;

  constructor(readonly prompt: AsyncIterable<SDKUserMessage>, readonly options: Options) {
    void (async () => {
      for await (const message of prompt) {
        this.received.push(message);
        this.onUserMessage?.(message);
      }
    })();
  }

  get canUseTool(): CanUseTool {
    const fn = this.options.canUseTool;
    if (fn === undefined) throw new Error("canUseTool missing");
    return fn;
  }

  send(message: Record<string, unknown>): void {
    const sdkMessage = message as unknown as SDKMessage;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter.resolve({ value: sdkMessage, done: false });
    else this.outbox.push(sdkMessage);
  }

  crash(error: Error): void {
    this.failure = error;
    this.finish();
  }

  finish(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      if (this.failure !== undefined) waiter.reject(this.failure);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  next(): Promise<IteratorResult<SDKMessage>> {
    const item = this.outbox.shift();
    if (item !== undefined) return Promise.resolve({ value: item, done: false });
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  return(): Promise<IteratorResult<SDKMessage>> {
    this.finish();
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  initializationResult(): Promise<SDKControlInitializeResponse> {
    return Promise.resolve({ commands: [{ name: "review", description: "Review code", argumentHint: "" }], models: [] } as unknown as SDKControlInitializeResponse);
  }

  supportedModels(): Promise<ModelInfo[]> {
    return Promise.resolve(MODELS);
  }

  setModel(model?: string): Promise<void> {
    this.models.push(model);
    return Promise.resolve();
  }

  interrupt(): Promise<undefined> {
    this.interrupts++;
    this.onInterrupt?.();
    return Promise.resolve(undefined);
  }

  setPermissionMode(mode: PermissionMode): Promise<void> {
    this.modes.push(mode);
    return Promise.resolve();
  }

  close(): void {
    this.closed = true;
    this.finish();
  }
}

// ---------- SDK message builders ----------

let uuidCounter = 0;
const base = (): Record<string, unknown> => ({ uuid: `u-${++uuidCounter}`, session_id: SESSION, parent_tool_use_id: null });

const messageStart = (id: string) => ({ type: "stream_event", ...base(), event: { type: "message_start", message: { id } } });
const textDelta = (text: string) => ({ type: "stream_event", ...base(), event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
const thinkingDelta = (thinking: string) => ({ type: "stream_event", ...base(), event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } } });
const assistant = (id: string, content: unknown[]) => ({ type: "assistant", ...base(), message: { id, role: "assistant", content } });
const toolResult = (toolUseId: string, text: string, isError = false) => ({
  type: "user",
  ...base(),
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: [{ type: "text", text }], is_error: isError }] },
});
const success = (stopReason = "end_turn") => ({ type: "result", subtype: "success", ...base(), is_error: false, result: "", stop_reason: stopReason, errors: undefined });
const interrupted = () => ({ type: "result", subtype: "error_during_execution", ...base(), is_error: true, stop_reason: null, terminal_reason: "aborted_tools", errors: [] });

// ---------- harness ----------

function setup(opts: { cancelTimeoutMs?: number; envModel?: string; configDir?: string } = {}) {
  const queries: FakeQuery[] = [];
  const queryImpl = ((params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => {
    if (typeof params.prompt === "string" || params.options === undefined) throw new Error("expected streaming input + options");
    const fake = new FakeQuery(params.prompt, params.options);
    queries.push(fake);
    return fake as unknown as Query;
  }) as typeof sdkQuery;
  const bridge = new ClaudeSdkBridge(
    // ANTHROPIC_MODEL and CLAUDE_CONFIG_DIR are pinned so the host's
    // environment and ~/.claude/settings.json cannot leak in.
    {
      root: ROOT,
      preset: {
        command: "unused",
        args: [],
        env: { ARCHMAP_TEST_ENV: "1", ANTHROPIC_MODEL: opts.envModel ?? "", CLAUDE_CONFIG_DIR: opts.configDir ?? "/nonexistent/archmap-test-claude" },
      },
      clientVersion: "0.1.0",
    },
    { queryImpl, ...(opts.cancelTimeoutMs !== undefined ? { cancelTimeoutMs: opts.cancelTimeoutMs } : {}) },
  );
  const events: BridgeEvent[] = [];
  bridge.on((event) => events.push(event));
  const current = (): FakeQuery => {
    const fake = queries.at(-1);
    if (fake === undefined) throw new Error("no query");
    return fake;
  };
  return { bridge, events, queries, current };
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const streamEvents = (events: BridgeEvent[]) =>
  events.flatMap((event) => (event.type === "stream" ? [event.event] : []));

const abortSignal = () => new AbortController();

describe("ClaudeSdkBridge", () => {
  it("starts a streaming-input query with the user's Claude setup and reports idle", async () => {
    const { bridge, events, current } = setup();
    await bridge.start();
    const options = current().options;
    expect(options.cwd).toBe(ROOT);
    expect(options.settingSources).toEqual(["user", "project", "local"]);
    expect(options.includePartialMessages).toBe(true);
    expect(options.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
    expect(options.permissionMode).toBe("default");
    expect(options.env?.ARCHMAP_TEST_ENV).toBe("1");
    expect(typeof options.sessionId).toBe("string");
    const idle = events.find((event) => event.type === "status" && event.state === "idle");
    expect(idle).toMatchObject({
      type: "status",
      state: "idle",
      agent: { name: "claude-agent-sdk", version: SDK_VERSION },
      sessionId: options.sessionId,
      modes: { currentModeId: "default" },
    });
    if (idle?.type === "status") expect(idle.modes?.available.map((mode) => mode.id)).toEqual(["default", "acceptEdits", "plan", "bypassPermissions"]);
    expect(bridge.status()).toBe("idle");
  });

  it("streams text and thought chunks without duplicating the assistant snapshot", async () => {
    const { bridge, events, current } = setup();
    await bridge.start();
    const fake = current();
    fake.onUserMessage = () => {
      fake.send(messageStart("msg_1"));
      fake.send(thinkingDelta("hmm"));
      fake.send(textDelta("Hel"));
      fake.send(textDelta("lo"));
      fake.send(assistant("msg_1", [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Hello" }]));
      fake.send(assistant("msg_2", [{ type: "text", text: " unstreamed" }]));
      fake.send(success());
    };
    const handle = bridge.prompt("t1", [
      { type: "text", text: "explain" },
      { type: "resource_link", uri: "file:///tmp/archmap-fake-repo/src/a.ts", name: "src/a.ts" },
    ]);
    await expect(handle.done).resolves.toEqual({ stopReason: "end_turn" });

    expect(fake.received[0]?.message.content).toEqual([
      { type: "text", text: "explain" },
      { type: "text", text: "[@src/a.ts](file:///tmp/archmap-fake-repo/src/a.ts)" },
    ]);
    expect(streamEvents(events)).toEqual([
      { kind: "thought", text: "hmm" },
      { kind: "text", text: "Hel" },
      { kind: "text", text: "lo" },
      { kind: "text", text: " unstreamed" },
    ]);
    const tail = events.slice(-2);
    expect(tail).toEqual([
      { type: "turn_finished", turnId: "t1", stopReason: "end_turn" },
      { type: "status", state: "idle", sessionId: fake.options.sessionId },
    ]);
    expect(events.some((event) => event.type === "status" && event.state === "busy")).toBe(true);
  });

  it("maps a tool call through a permission allow (always) to a completed result", async () => {
    const { bridge, events, current } = setup();
    await bridge.start();
    const fake = current();
    const input = { file_path: `${ROOT}/src/a.ts`, old_string: "a", new_string: "b" };
    let decision: Promise<PermissionResult | null> | undefined;
    fake.onUserMessage = () => {
      fake.send(assistant("msg_1", [{ type: "tool_use", id: "toolu_1", name: "Edit", input }]));
      decision = fake.canUseTool("Edit", input, {
        signal: abortSignal().signal,
        toolUseID: "toolu_1",
        requestId: "ctl_1",
        suggestions: [{ type: "addRules", rules: [{ toolName: "Edit" }], behavior: "allow", destination: "localSettings" }],
      });
    };
    const handle = bridge.prompt("t2", [{ type: "text", text: "fix it" }]);
    const permission = await waitFor(() => events.find((event) => event.type === "permission"));
    if (permission.type !== "permission") throw new Error("unreachable");
    expect(permission.toolCall).toMatchObject({ toolCallId: "toolu_1", kind: "edit", title: "Edit src/a.ts", status: "pending", locations: [{ path: "src/a.ts" }] });
    expect(permission.options.map((option) => option.kind)).toEqual(["allow_once", "allow_always", "reject_once"]);

    expect(bridge.answerPermission(permission.requestId, { optionId: "allow_always" })).toBe(true);
    expect(bridge.answerPermission(permission.requestId, { optionId: "allow" })).toBe(false);
    await expect(decision).resolves.toEqual({
      behavior: "allow",
      updatedInput: input,
      updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Edit" }], behavior: "allow", destination: "session" }],
    });
    fake.send(toolResult("toolu_1", "ok"));
    fake.send(success());
    await expect(handle.done).resolves.toEqual({ stopReason: "end_turn" });

    expect(streamEvents(events)).toEqual([
      { kind: "tool_call", toolCall: expect.objectContaining({ toolCallId: "toolu_1", status: "pending" }) },
      { kind: "diff", toolCallId: "toolu_1", path: "src/a.ts", oldText: "a", newText: "b" },
      { kind: "tool_call", toolCall: expect.objectContaining({ toolCallId: "toolu_1", status: "in_progress" }) },
      { kind: "tool_result", toolCall: expect.objectContaining({ toolCallId: "toolu_1", status: "completed", output: "ok" }) },
    ]);
    expect(events).toContainEqual({ type: "permission_resolved", turnId: "t2", requestId: permission.requestId, optionId: "allow_always" });
  });

  it("maps Bash to execute, TodoWrite to a plan, and a rejected permission to a deny", async () => {
    const { bridge, events, current } = setup();
    await bridge.start();
    const fake = current();
    const input = { command: "rm -rf build", description: "Clean build" };
    let decision: Promise<PermissionResult | null> | undefined;
    fake.onUserMessage = () => {
      fake.send(assistant("msg_1", [
        { type: "tool_use", id: "toolu_p", name: "TodoWrite", input: { todos: [{ content: "Clean", status: "in_progress" }, { content: "Build", status: "pending" }] } },
      ]));
      decision = fake.canUseTool("Bash", input, { signal: abortSignal().signal, toolUseID: "toolu_2", requestId: "ctl_2" });
    };
    const handle = bridge.prompt("t3", [{ type: "text", text: "clean" }]);
    const permission = await waitFor(() => events.find((event) => event.type === "permission"));
    if (permission.type !== "permission") throw new Error("unreachable");
    expect(permission.toolCall).toMatchObject({ kind: "execute", title: "Clean build", command: "rm -rf build" });
    bridge.answerPermission(permission.requestId, { optionId: "reject" });
    await expect(decision).resolves.toEqual({ behavior: "deny", message: "User declined tool execution." });
    fake.send(toolResult("toolu_2", "User declined tool execution.", true));
    fake.send(success());
    await handle.done;

    const stream = streamEvents(events);
    expect(stream).toContainEqual({
      kind: "plan",
      entries: [
        { content: "Clean", priority: "medium", status: "in_progress" },
        { content: "Build", priority: "medium", status: "pending" },
      ],
    });
    expect(stream.filter((event) => event.kind === "tool_call" && event.toolCall.toolCallId === "toolu_2").map((event) => event.kind === "tool_call" && event.toolCall.status)).toEqual(["pending"]);
    expect(stream.at(-1)).toMatchObject({ kind: "tool_result", toolCall: { toolCallId: "toolu_2", status: "failed" } });
  });

  it("cancel resolves pending permissions as cancelled, interrupts, and finishes cancelled", async () => {
    const { bridge, events, current } = setup();
    await bridge.start();
    const fake = current();
    let decision: Promise<PermissionResult | null> | undefined;
    fake.onUserMessage = () => {
      fake.send(messageStart("msg_1"));
      fake.send(textDelta("working"));
      decision = fake.canUseTool("Write", { file_path: `${ROOT}/x.txt`, content: "x" }, { signal: abortSignal().signal, toolUseID: "toolu_3", requestId: "ctl_3" });
    };
    fake.onInterrupt = () => {
      fake.send(textDelta(" late text is dropped"));
      fake.send(interrupted());
    };
    const handle = bridge.prompt("t4", [{ type: "text", text: "go" }]);
    const permission = await waitFor(() => events.find((event) => event.type === "permission"));
    if (permission.type !== "permission") throw new Error("unreachable");

    await bridge.cancel("t4");
    await expect(decision).resolves.toEqual({ behavior: "deny", message: "User cancelled tool execution.", interrupt: true });
    await expect(handle.done).resolves.toEqual({ stopReason: "cancelled" });
    expect(fake.interrupts).toBe(1);
    expect(events).toContainEqual({ type: "permission_resolved", turnId: "t4", requestId: permission.requestId, cancelled: true });
    expect(streamEvents(events).filter((event) => event.kind === "text")).toEqual([{ kind: "text", text: "working" }]);
    expect(bridge.status()).toBe("idle");
    expect(bridge.answerPermission(permission.requestId, { optionId: "allow" })).toBe(false);
  });

  it("kills the CLI when an interrupt is not answered in time, then resumes on the next prompt", async () => {
    const { bridge, current, queries } = setup({ cancelTimeoutMs: 30 });
    await bridge.start();
    const first = current();
    first.onUserMessage = () => first.send(textDelta("stuck"));
    const handle = bridge.prompt("t5", [{ type: "text", text: "go" }]);
    await waitFor(() => first.received.length === 1 || undefined);
    await bridge.cancel("t5");
    const outcome = await handle.done;
    expect(outcome.stopReason).toBe("error");
    expect(first.closed).toBe(true);

    const next = bridge.prompt("t6", [{ type: "text", text: "again" }]);
    const second = await waitFor(() => (queries.length === 2 ? queries[1] : undefined));
    // No transcript was persisted (no init/result), so this is a fresh session.
    expect(second.options.resume).toBeUndefined();
    await waitFor(() => second.received.length === 1 || undefined);
    second.send({ type: "system", subtype: "init", ...base(), permissionMode: "default" });
    second.send(success());
    await expect(next.done).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("throws BusyError while a turn is active", async () => {
    const { bridge, current } = setup();
    await bridge.start();
    const fake = current();
    const handle = bridge.prompt("t7", [{ type: "text", text: "one" }]);
    expect(() => bridge.prompt("t8", [{ type: "text", text: "two" }])).toThrow(BusyError);
    await waitFor(() => fake.received.length === 1 || undefined);
    fake.send(success());
    await handle.done;
    expect(() => bridge.prompt("t9", [{ type: "text", text: "three" }])).not.toThrow();
  });

  it("setMode switches the live permission mode and re-emits modes", async () => {
    const { bridge, events, current } = setup();
    await bridge.start();
    await bridge.setMode("plan");
    expect(current().modes).toEqual(["plan"]);
    expect(events.at(-1)).toMatchObject({ type: "status", state: "idle", modes: { currentModeId: "plan" } });
    await expect(bridge.setMode("nonsense")).rejects.toThrow(/unknown mode/);
    // The CLI can change the mode itself (e.g. after ExitPlanMode).
    current().send({ type: "system", subtype: "status", ...base(), status: null, permissionMode: "acceptEdits" });
    await waitFor(() => events.find((event) => event.type === "status" && event.modes?.currentModeId === "acceptEdits"));
  });

  it("reports supportedModels() as models, current = default", async () => {
    const { bridge, events, current } = setup();
    await bridge.start();
    expect(current().options.model).toBeUndefined();
    expect(events.at(-1)).toMatchObject({
      type: "status",
      state: "idle",
      models: {
        currentModelId: "default",
        available: [
          { id: "default", name: "Default (recommended)", description: "Opus 5.5 · Most capable" },
          { id: "sonnet", name: "Sonnet 5", description: "Sonnet 5 · Everyday tasks" },
          { id: "haiku", name: "Haiku" },
        ],
      },
    });
  });

  it("setModel switches the live query (also mid-turn) and keeps the model for a resumed query", async () => {
    const { bridge, events, current, queries } = setup();
    await bridge.start();
    const first = current();
    await bridge.setModel("haiku");
    expect(first.models).toEqual(["haiku"]);
    expect(events.at(-1)).toMatchObject({ type: "status", state: "idle", models: { currentModelId: "haiku" } });
    await expect(bridge.setModel("gpt-9")).rejects.toThrow(/unknown model/);

    // Mid-turn: forwarded to the live query; the CLI applies it to the next request.
    first.onUserMessage = () => {
      first.send({ type: "system", subtype: "init", ...base(), permissionMode: "default" });
    };
    const handle = bridge.prompt("tm", [{ type: "text", text: "go" }]);
    await waitFor(() => first.received.length === 1 || undefined);
    await bridge.setModel("sonnet");
    expect(first.models).toEqual(["haiku", "sonnet"]);
    expect(events.at(-1)).toMatchObject({ type: "status", state: "busy", models: { currentModelId: "sonnet" } });

    // The CLI dies; the resumed query starts on the chosen model.
    first.crash(new Error("Claude Code process exited with code 1"));
    await handle.done;
    bridge.prompt("tn", [{ type: "text", text: "again" }]);
    const second = await waitFor(() => (queries.length === 2 ? queries[1] : undefined));
    expect(second.options.resume).toBe(first.options.sessionId);
    expect(second.options.model).toBe("sonnet");

    // reset keeps it too; choosing "default" leaves the model to the CLI.
    await bridge.reset();
    expect(current().options.model).toBe("sonnet");
    await bridge.setModel("default");
    await bridge.reset();
    expect(current().options.model).toBeUndefined();
  });

  it("shows the settings.json model as current, and an explicit default overrides it on new queries", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "archmap-claude-config-"));
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({ model: "sonnet" }));
    const { bridge, events, current } = setup({ configDir });
    await bridge.start();
    expect(current().options.model).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ models: { currentModelId: "sonnet" } });
    await bridge.setModel("default");
    expect(events.at(-1)).toMatchObject({ models: { currentModelId: "default" } });
    await bridge.reset();
    // Not passed as options.model; applied with setModel after init instead.
    expect(current().options.model).toBeUndefined();
    expect(current().models).toEqual(["default"]);
  });

  it("honours ANTHROPIC_MODEL as the initial model", async () => {
    const { bridge, events, current } = setup({ envModel: "claude-sonnet-5" });
    await bridge.start();
    expect(current().options.model).toBe("claude-sonnet-5");
    // Shown as the picker row it resolves to.
    expect(events.at(-1)).toMatchObject({ models: { currentModelId: "sonnet" } });
  });

  it("dispatches a known $skill mention as the trailing slash command", async () => {
    const { bridge, current } = setup();
    await bridge.start();
    const fake = current();
    bridge.prompt("t10", [
      { type: "text", text: "context pack\n\nplease $review the invoices route" },
      { type: "resource_link", uri: "file:///tmp/archmap-fake-repo/a.ts", name: "a.ts" },
    ]);
    await waitFor(() => fake.received.length === 1 || undefined);
    expect(fake.received[0]?.message.content).toEqual([
      { type: "text", text: "context pack\n\nplease" },
      { type: "text", text: "[@a.ts](file:///tmp/archmap-fake-repo/a.ts)" },
      { type: "text", text: "/review the invoices route" },
    ]);
  });

  it("finishes the turn with an error when the CLI exits, and resumes the session next time", async () => {
    const { bridge, events, current, queries } = setup();
    await bridge.start();
    const first = current();
    first.onUserMessage = () => {
      first.send({ type: "system", subtype: "init", ...base(), permissionMode: "default" });
      first.crash(new Error("Claude Code process exited with code 1"));
    };
    const handle = bridge.prompt("t11", [{ type: "text", text: "go" }]);
    await expect(handle.done).resolves.toEqual({ stopReason: "error", error: "Claude Code process exited with code 1" });
    expect(events.at(-1)).toMatchObject({ type: "status", state: "error", error: "Claude Code process exited with code 1" });

    bridge.prompt("t12", [{ type: "text", text: "retry" }]);
    const second = await waitFor(() => (queries.length === 2 ? queries[1] : undefined));
    expect(second.options.resume).toBe(first.options.sessionId);
    expect(second.options.sessionId).toBeUndefined();
  });

  it("stop() cancels the active turn and closes the query", async () => {
    const { bridge, events, current } = setup();
    await bridge.start();
    const fake = current();
    const handle = bridge.prompt("t13", [{ type: "text", text: "go" }]);
    await bridge.stop();
    await expect(handle.done).resolves.toEqual({ stopReason: "cancelled" });
    expect(fake.closed).toBe(true);
    expect(bridge.status()).toBe("stopped");
    expect(events.at(-1)).toEqual({ type: "status", state: "stopped" });
  });
});

import { modelDisplayName } from "../src/acp/claude-sdk-bridge.js";

it("modelDisplayName puts the concrete model version in the picker name", () => {
  expect(modelDisplayName("opus[1m]", "Opus (1M context)", "Opus 5.5 with 1M context · Best for everyday, complex tasks")).toBe("Opus 5.5 · 1M");
  expect(modelDisplayName("sonnet", "Sonnet", "Sonnet 5 · Efficient for routine tasks")).toBe("Sonnet 5");
  expect(modelDisplayName("haiku", "Haiku", "Haiku 4.5 · Fastest for quick answers")).toBe("Haiku 4.5");
  expect(modelDisplayName("default", "Default (recommended)", "Opus 5.5 with 1M context")).toBe("Default (recommended)");
  expect(modelDisplayName("custom", "Custom", "no version here")).toBe("Custom");
});
