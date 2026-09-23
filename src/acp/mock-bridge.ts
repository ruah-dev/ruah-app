// src/acp/mock-bridge.ts — scripted AcpBridge for --mock. Implements the
// AcpBridge interface from src/acp/bridge.ts (shared with WP-A; WP-A's real
// bridge is not imported). No agent process is spawned: each prompt() runs a
// scripted turn — six text chunks 40 ms apart, a read tool_call/tool_result on
// the node's first file, an edit tool_call, a permission request with three
// options (allow / allow_always / reject), then diff + completed (or failed)
// tool_result, two more chunks, end_turn. cancel() finishes with stopReason
// "cancelled" within 100 ms. The turn's file comes from the blocks'
// resource_link names. The model picker is static (default/opus/sonnet/haiku)
// and setModel() only records the choice.
import type { AcpBridge, BridgeEvent, BridgeOptions, TurnHandle } from "./bridge.js";
import { BusyError } from "./bridge.js";
import { randomUUID } from "node:crypto";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { AgentState, ModelState, StopReason, StreamEvent, ToolCallView } from "../contracts/ws.js";

export interface MockBridgeOptions extends BridgeOptions {
  chunkDelayMs?: number;
}

const MOCK_AGENT = { name: "ruah-mock", version: "0.1.0" } as const;
const SESSION_ID = "mock-session-0000-0000-0000-000000000000";
const MOCK_MODELS: ModelState["available"] = [
  { id: "default", name: "Default (recommended)", description: "Use the default model" },
  { id: "opus", name: "Opus", description: "Most capable for complex work" },
  { id: "sonnet", name: "Sonnet", description: "Balanced speed and capability" },
  { id: "haiku", name: "Haiku", description: "Fastest for quick answers" },
];

interface ScriptedTurn {
  turnId: string;
  cancelled: boolean;
  timers: NodeJS.Timeout[];
}

interface PendingPermission {
  requestId: string;
  resolve: (answer: { optionId: string } | { cancelled: true }) => void;
}

function firstFile(blocks: readonly ContentBlock[]): string {
  for (const block of blocks) {
    if (block.type === "resource_link") return block.name;
  }
  return "README.md";
}

export class MockBridge implements AcpBridge {
  private state: AgentState = "stopped";
  private readonly listeners = new Set<(event: BridgeEvent) => void>();
  private active: ScriptedTurn | undefined;
  private pendingPermission: PendingPermission | undefined;
  private finishActive: ((stopReason: StopReason) => void) | undefined;
  private readonly delay: number;
  private modelId = "default";
  private sessionId = SESSION_ID;

  constructor(options: MockBridgeOptions) {
    this.delay = options.chunkDelayMs ?? 40;
  }

  async start(): Promise<void> {
    this.state = "idle";
    this.emit({ type: "status", state: "idle", agent: { ...MOCK_AGENT }, sessionId: this.sessionId, models: this.models() });
  }

  status(): AgentState {
    return this.state;
  }

  /** Accepts image blocks (and ignores them) so the viewer's attachment flow can be tried without a model. */
  supportsImages(): boolean {
    return true;
  }

  prompt(turnId: string, blocks: ContentBlock[]): TurnHandle {
    if (this.active !== undefined) throw new BusyError();
    const turn: ScriptedTurn = { turnId, cancelled: false, timers: [] };
    this.active = turn;
    this.state = "busy";
    this.emit({ type: "status", state: "busy", sessionId: this.sessionId });

    let resolveDone: (value: { stopReason: StopReason; error?: string }) => void = () => {};
    const done = new Promise<{ stopReason: StopReason; error?: string }>((resolve) => {
      resolveDone = resolve;
    });

    const finish = (stopReason: StopReason): void => {
      if (this.active !== turn) return;
      for (const timer of turn.timers) clearTimeout(timer);
      this.active = undefined;
      this.pendingPermission = undefined;
      this.finishActive = undefined;
      this.state = "idle";
      this.emit({ type: "turn_finished", turnId, stopReason });
      this.emit({ type: "status", state: "idle", sessionId: this.sessionId });
      resolveDone({ stopReason });
    };
    this.finishActive = finish;

    const emitStream = (event: StreamEvent): void => {
      this.emit({ type: "stream", turnId, event });
    };

    const emitText = (text: string): void => {
      emitStream({ kind: "text", text });
    };

    const later = (fn: () => void, ms = this.delay): void => {
      turn.timers.push(setTimeout(() => {
        if (turn.cancelled || this.active !== turn) return;
        fn();
      }, ms));
    };

    const runEditOutcome = (allowed: boolean): void => {
      const toolCallId = "toolu_02";
      if (allowed) {
        emitStream({
          kind: "diff",
          toolCallId,
          path: file,
          oldText: "  currency: z.enum([\"EUR\", \"USD\"]),",
          newText: "  currency: z.enum([\"EUR\", \"USD\", \"GBP\"]),",
        });
        emitStream({
          kind: "tool_result",
          toolCall: {
            toolCallId,
            title: `Edit ${file}`,
            kind: "edit",
            status: "completed",
            locations: [{ path: file, line: 12 }],
          },
        });
      } else {
        emitStream({
          kind: "tool_result",
          toolCall: {
            toolCallId,
            title: `Edit ${file}`,
            kind: "edit",
            status: "failed",
            locations: [{ path: file, line: 12 }],
          },
        });
      }
      later(() => emitText("The enum rejected GBP invoices. "));
      later(() => emitText("I added it."), this.delay * 2);
      later(() => finish("end_turn"), this.delay * 3);
    };

    let file = firstFile(blocks);
    const readToolCallId = "toolu_01";

    // Step timeline (each step one delay apart):
    // 0..5 text chunks, 6 read tool_call, 7 read tool_result, 8 edit tool_call
    // + permission.request, then the turn waits for answerPermission().
    for (let i = 0; i < 6; i++) {
      later(() => emitText(`Mock step ${i + 1}: reading ${file}. `), this.delay * i);
    }
    later(() => {
      emitStream({
        kind: "tool_call",
        toolCall: {
          toolCallId: readToolCallId,
          title: `Read ${file}`,
          kind: "read",
          status: "in_progress",
          locations: [{ path: file }],
        },
      });
    }, this.delay * 6);
    later(() => {
      emitStream({
        kind: "tool_result",
        toolCall: {
          toolCallId: readToolCallId,
          title: `Read ${file}`,
          kind: "read",
          status: "completed",
          locations: [{ path: file }],
          output: "// mock file contents",
        },
      });
    }, this.delay * 7);
    later(() => {
      const requestId = `perm_${turn.turnId}`;
      const editToolCall: ToolCallView = {
        toolCallId: "toolu_02",
        title: `Edit ${file}`,
        kind: "edit",
        status: "pending",
        locations: [{ path: file, line: 12 }],
      };
      emitStream({ kind: "tool_call", toolCall: editToolCall });
      this.emit({
        type: "permission",
        turnId,
        requestId,
        toolCall: editToolCall,
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "allow_always", name: "Always allow edits in this session", kind: "allow_always" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });
      this.pendingPermission = {
        requestId,
        resolve: (answer) => {
          if ("cancelled" in answer) {
            this.emit({ type: "permission_resolved", turnId, requestId, cancelled: true });
            finish("cancelled");
            return;
          }
          this.emit({ type: "permission_resolved", turnId, requestId, optionId: answer.optionId });
          runEditOutcome(answer.optionId === "allow" || answer.optionId === "allow_always");
        },
      };
    }, this.delay * 8);

    return { turnId, done };
  }

  async cancel(turnId: string): Promise<void> {
    const turn = this.active;
    if (turn === undefined || turn.turnId !== turnId) return;
    turn.cancelled = true;
    this.pendingPermission?.resolve({ cancelled: true });
    this.pendingPermission = undefined;
    for (const timer of turn.timers) clearTimeout(timer);
    turn.timers = [];
    // Cancelled turns finish within 100 ms (contract §2.2 rule 5 target).
    setTimeout(() => this.finishActive?.("cancelled"), 20);
  }

  answerPermission(requestId: string, answer: { optionId: string } | { cancelled: true }): boolean {
    const pending = this.pendingPermission;
    if (pending === undefined || pending.requestId !== requestId) return false;
    this.pendingPermission = undefined;
    pending.resolve(answer);
    return true;
  }

  async setMode(_modeId: string): Promise<void> {
    // The mock accepts any mode.
  }

  async setModel(modelId: string): Promise<void> {
    if (!MOCK_MODELS.some((model) => model.id === modelId)) throw new Error(`unknown model: ${modelId}`);
    this.modelId = modelId;
    this.emit({ type: "status", state: this.state, sessionId: this.sessionId, models: this.models() });
  }

  async reset(): Promise<void> {
    // The mock keeps its scripted behaviour.
  }

  /** Records the session id (a fresh random one for undefined); the script does not change. */
  async useSession(sessionId: string | undefined): Promise<void> {
    if (this.active !== undefined) await this.cancel(this.active.turnId);
    this.sessionId = sessionId ?? `mock-session-${randomUUID()}`;
    if (this.state !== "stopped") this.emit({ type: "status", state: this.state, agent: { ...MOCK_AGENT }, sessionId: this.sessionId, models: this.models() });
  }

  async stop(): Promise<void> {
    if (this.active !== undefined) {
      this.active.cancelled = true;
      this.pendingPermission = undefined;
      this.finishActive?.("cancelled");
    }
    this.state = "stopped";
    this.emit({ type: "status", state: "stopped" });
  }

  on(listener: (event: BridgeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private models(): ModelState {
    return { currentModelId: this.modelId, available: MOCK_MODELS.map((model) => ({ ...model })) };
  }

  private emit(event: BridgeEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
