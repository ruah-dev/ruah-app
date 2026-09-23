// test/fake-agent.ts — a tiny scripted ACP agent built with the SDK's agent()
// app, served over stdio (ndJsonStream). The script is chosen by the prompt
// text (first text block), so one process can run several scenarios:
//   text        whitespace-only chunk, three text chunks, end_turn
//   tool        read tool_call with absolute locations, 10 KiB output, end_turn
//   permission  edit tool_call (+diff), session/request_permission, outcome →
//               completed/failed/cancelled tool update, end_turn or cancelled
//   hang        like permission, but ignores session/cancel (never answers)
//   slow        text every 30 ms until session/cancel, then cancelled
//   extras      _ext notification, foreign-session update, replay update, text
//   crash       one text chunk, then process.exit(3)
//   automodel   config_option_update switching the model to haiku, text, end_turn
// Sessions advertise a `model` select config option (category "model");
// session/set_config_option switches it. With FAKE_AGENT_CONFIG_MODES=1 the
// session has no `modes`; modes exist only as the `mode` config option.
// Protocol-visible side effects are logged to stderr as `fake: …` lines so
// tests can assert ordering (e.g. permission cancelled before session/cancel).
import { Readable, Writable } from "node:stream";
import path from "node:path";
import { agent, ndJsonStream, type AgentContext, type ContentBlock, type SessionConfigOption } from "@agentclientprotocol/sdk";

const log = (line: string): void => {
  process.stderr.write(`fake: ${line}\n`);
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface SessionState {
  cwd: string;
  modeId: string;
  modelId: string;
  cancelled: boolean;
  onCancel: (() => void) | undefined;
}

const sessions = new Map<string, SessionState>();

const CONFIG_MODES = process.env.FAKE_AGENT_CONFIG_MODES === "1";
// FAKE_AGENT_LOAD_SESSION=1: advertises loadSession; session/load accepts any
// id (as if persisted) and replays one history message before answering.
const LOAD_SESSION = process.env.FAKE_AGENT_LOAD_SESSION === "1";
// FAKE_AGENT_IMAGES=1: advertises promptCapabilities.image.
const IMAGES = process.env.FAKE_AGENT_IMAGES === "1";

const MODELS = [
  { value: "default", name: "Default (recommended)", description: "Opus" },
  { value: "sonnet", name: "Sonnet" },
  { value: "haiku", name: "Haiku", description: "Fastest" },
];

function configOptions(state: SessionState): SessionConfigOption[] {
  return [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: state.modeId,
      options: [{ value: "default", name: "Manual" }, { value: "plan", name: "Plan" }],
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: state.modelId,
      options: [{ group: "claude", name: "Claude", options: MODELS }],
    },
  ];
}
let sessionCounter = 0;

function waitForCancel(state: SessionState, timeoutMs: number): Promise<boolean> {
  if (state.cancelled) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    state.onCancel = () => {
      clearTimeout(timer);
      resolve(true);
    };
  });
}

function scriptOf(blocks: readonly ContentBlock[]): string {
  for (const block of blocks) {
    if (block.type === "text") return block.text.trim().split(/\s+/)[0] ?? "";
  }
  return "";
}

async function say(client: AgentContext, sessionId: string, text: string): Promise<void> {
  await client.notify("session/update", {
    sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  });
}

async function permissionScript(
  client: AgentContext,
  sessionId: string,
  state: SessionState,
  honourCancel: boolean,
): Promise<"end_turn" | "cancelled"> {
  const file = path.join(state.cwd, "src", "edit.ts");
  await say(client, sessionId, "Editing. ");
  const diff = { type: "diff" as const, path: file, oldText: "a", newText: "b" };
  await client.notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "tc_edit",
      title: "Edit src/edit.ts",
      kind: "edit",
      status: "pending",
      locations: [{ path: file, line: 3 }],
      content: [diff],
    },
  });
  const response = await client.request("session/request_permission", {
    sessionId,
    toolCall: { toolCallId: "tc_edit", title: "Edit src/edit.ts", kind: "edit" },
    options: [
      { optionId: "opt-allow", name: "Allow", kind: "allow_once" },
      { optionId: "opt-always", name: "Always allow", kind: "allow_always" },
      { optionId: "opt-reject", name: "Reject", kind: "reject_once" },
    ],
  });
  if (response.outcome.outcome === "cancelled") {
    log("permission outcome=cancelled");
    if (!honourCancel) {
      log("ignoring cancel");
      await new Promise<never>(() => {});
    }
    const cancelled = await waitForCancel(state, 5_000);
    log(`cancel received=${cancelled}`);
    return "cancelled";
  }
  const optionId = response.outcome.optionId;
  log(`permission outcome=selected:${optionId}`);
  const allowed = optionId === "opt-allow" || optionId === "opt-always";
  await client.notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc_edit",
      status: allowed ? "completed" : "failed",
      ...(allowed ? { content: [diff] } : {}),
    },
  });
  await say(client, sessionId, allowed ? "Done." : "Rejected.");
  return "end_turn";
}

const app = agent({ name: "fake-agent" })
  .onRequest("initialize", () => ({
    protocolVersion: 1,
    agentInfo: { name: "fake-agent", version: "0.0.1" },
    agentCapabilities: {
      ...(LOAD_SESSION ? { loadSession: true } : {}),
      ...(IMAGES ? { promptCapabilities: { image: true } } : {}),
    },
    authMethods: [],
  }))
  .onRequest("session/load", async ({ params, client }) => {
    if (!LOAD_SESSION) throw new Error("session/load not supported");
    const state: SessionState = sessions.get(params.sessionId) ?? { cwd: params.cwd, modeId: "default", modelId: "default", cancelled: false, onCancel: undefined };
    sessions.set(params.sessionId, state);
    log(`session/load ${params.sessionId} cwd=${params.cwd}`);
    await client.notify("session/update", {
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "replayed history" } },
    });
    return { configOptions: configOptions(state) };
  })
  .onRequest("session/new", ({ params }) => {
    sessionCounter += 1;
    const sessionId = `fake-session-${sessionCounter}`;
    const state: SessionState = { cwd: params.cwd, modeId: "default", modelId: "default", cancelled: false, onCancel: undefined };
    sessions.set(sessionId, state);
    log(`session/new ${sessionId} cwd=${params.cwd}`);
    if (CONFIG_MODES) return { sessionId, configOptions: configOptions(state) };
    return {
      sessionId,
      configOptions: configOptions(state),
      modes: {
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Manual", description: "Ask first" },
          { id: "plan", name: "Plan" },
        ],
      },
    };
  })
  .onRequest("session/set_mode", async ({ params, client }) => {
    const state = sessions.get(params.sessionId);
    if (state === undefined) throw new Error(`unknown session ${params.sessionId}`);
    state.modeId = params.modeId;
    log(`set_mode ${params.modeId}`);
    await client.notify("session/update", {
      sessionId: params.sessionId,
      update: { sessionUpdate: "current_mode_update", currentModeId: params.modeId },
    });
    return {};
  })
  .onRequest("session/set_config_option", ({ params }) => {
    const state = sessions.get(params.sessionId);
    if (state === undefined) throw new Error(`unknown session ${params.sessionId}`);
    if (typeof params.value !== "string") throw new Error(`unsupported value for ${params.configId}`);
    if (params.configId === "mode" && (params.value === "default" || params.value === "plan")) {
      state.modeId = params.value;
    } else if (params.configId === "model" && MODELS.some((m) => m.value === params.value)) {
      state.modelId = params.value;
    } else {
      throw new Error(`Invalid value for config option ${params.configId}: ${params.value}`);
    }
    log(`set_config_option ${params.sessionId} ${params.configId}=${params.value}`);
    return { configOptions: configOptions(state) };
  })
  .onNotification("session/cancel", ({ params }) => {
    log(`session/cancel ${params.sessionId}`);
    const state = sessions.get(params.sessionId);
    if (state === undefined) return;
    state.cancelled = true;
    state.onCancel?.();
  })
  .onRequest("session/prompt", async ({ params, client }) => {
    const sessionId = params.sessionId;
    const state = sessions.get(sessionId);
    if (state === undefined) throw new Error(`unknown session ${sessionId}`);
    state.cancelled = false;
    state.onCancel = undefined;
    const script = scriptOf(params.prompt);
    log(`prompt ${script}`);
    switch (script) {
      case "text": {
        await say(client, sessionId, "  ");
        for (const chunk of ["Hello", " ", "world"]) await say(client, sessionId, chunk);
        return { stopReason: "end_turn" };
      }
      case "tool": {
        const file = path.join(state.cwd, "src", "a.ts");
        await client.notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tc_read",
            title: "Read src/a.ts",
            kind: "read",
            status: "in_progress",
            locations: [{ path: file, line: 1 }, { path: "/etc/hosts" }],
            rawInput: { file_path: file },
          },
        });
        await client.notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tc_read",
            status: "completed",
            content: [{ type: "content", content: { type: "text", text: "x".repeat(10 * 1024) } }],
          },
        });
        await say(client, sessionId, "Read it.");
        return { stopReason: "end_turn" };
      }
      case "permission":
        return { stopReason: await permissionScript(client, sessionId, state, true) };
      case "hang":
        return { stopReason: await permissionScript(client, sessionId, state, false) };
      case "slow": {
        for (let i = 0; i < 200 && !state.cancelled; i++) {
          await say(client, sessionId, `${i} `);
          await sleep(30);
        }
        return { stopReason: state.cancelled ? "cancelled" : "end_turn" };
      }
      case "extras": {
        await client.notify("_ext/notification", { hello: true });
        await client.notify("session/update", {
          sessionId: "some-other-session",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "FOREIGN" } },
        });
        await client.notify("session/update", {
          sessionId,
          _meta: { isReplay: true },
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "REPLAY" } },
        });
        await client.notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "plan",
            entries: [{ content: "Look", priority: "high", status: "in_progress" }],
          },
        });
        await say(client, sessionId, "ok");
        return { stopReason: "end_turn" };
      }
      case "automodel": {
        state.modelId = "haiku";
        await client.notify("session/update", {
          sessionId,
          update: { sessionUpdate: "config_option_update", configOptions: configOptions(state) },
        });
        await say(client, sessionId, "switched");
        return { stopReason: "end_turn" };
      }
      case "crash": {
        await say(client, sessionId, "about to crash");
        log("crashing");
        setTimeout(() => process.exit(3), 20);
        await new Promise<never>(() => {});
        return { stopReason: "end_turn" };
      }
      default: {
        await say(client, sessionId, `unknown script: ${script}`);
        return { stopReason: "end_turn" };
      }
    }
  });

// Logs every inbound frame in wire order (`recv <method>` / `recv response <result>`),
// independent of how the SDK schedules handler continuations.
const decoder = new TextDecoder();
let pending = "";
const wireTap = new TransformStream<Uint8Array, Uint8Array>({
  transform(chunk, controller) {
    pending += decoder.decode(chunk, { stream: true });
    for (let i = pending.indexOf("\n"); i >= 0; i = pending.indexOf("\n")) {
      const line = pending.slice(0, i);
      pending = pending.slice(i + 1);
      try {
        const frame = JSON.parse(line) as { method?: string; result?: unknown };
        if (typeof frame.method === "string") log(`recv ${frame.method}`);
        else if ("result" in frame) log(`recv response ${JSON.stringify(frame.result)}`);
      } catch {
        // not JSON; the SDK reports it
      }
    }
    controller.enqueue(chunk);
  },
});
const stdin = (Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>).pipeThrough(wireTap);
const connection = app.connect(ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, stdin));
void connection.closed.then(() => process.exit(0));
