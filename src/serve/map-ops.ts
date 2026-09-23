// src/serve/map-ops.ts — MapOpsService: how coding agents edit the open
// project's architecture map (CONTRACTS §1.7). Every write goes through the
// project's ArchitectureStore (validated, saved atomically, broadcast to all
// viewers with `by: { kind: "agent", agentId, turnId }` and a per-element
// `changes` summary). Before the first op of a turn the map is snapshotted
// in memory, so the user can undo that turn's map changes later.
//
// Agents reach it two ways: the Claude Agent SDK through an in-process MCP
// server (no token needed), ACP agents through `archmap mcp` (stdio) which
// calls the token-authenticated /api/arch endpoints (map-ops-http.ts). Tokens
// are per bridge (agent × project) random capabilities, never logged.
import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import type { Architecture } from "../contracts/architecture.js";
import type { ArchOp, ArchOpsResponse, MapChange } from "../contracts/map.js";
import type { AgentMapTools, StdioMcpServerSpec } from "../acp/bridge.js";
import { applyOps, OpError, revertTurn } from "../mcp/ops.js";
import { MAP_SERVER_INSTRUCTIONS, MAP_SERVER_NAME, sdkToolNames, type MapBackend } from "../mcp/tools.js";
import { createMapSdkServer } from "../mcp/sdk-server.js";
import type { ArchitectureStore } from "./architecture-store.js";

/** What the service needs from the SessionHub. */
export interface MapOpsHost {
  readonly store: ArchitectureStore | null;
  agentId(): string;
  activeTurnId(): string | undefined;
  /** Adds the changes to the running turn's record (stored with the chat). */
  recordMapChanges?(turnId: string, changes: MapChange[]): void;
}

/** Who is calling: the agent and the project root its bridge works in. */
export interface AgentMapContext {
  agentId: string;
  root: string;
}

export class MapOpsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "MapOpsError";
  }
}

interface TurnSnapshot {
  root: string;
  agentId: string;
  before: Architecture;
  after: Architecture;
  changes: MapChange[];
}

export interface MapOpsServiceOptions {
  version: string;
  /** How to start `archmap mcp` (default: this process's node + CLI entry). */
  launch?: () => { command: string; args: string[]; env?: Record<string, string> };
  /** How many turns keep an undo snapshot (default 30, oldest dropped first). */
  maxTurns?: number;
}

const hash = (token: string): string => createHash("sha256").update(token).digest("hex");

/** node + the running CLI (dev: tsx loader flags from execArgv; desktop: Electron as node). */
function defaultLaunch(): { command: string; args: string[]; env?: Record<string, string> } {
  const entry = process.argv[1] !== undefined ? realpathSync(process.argv[1]) : "archmap";
  return {
    command: process.execPath,
    args: [...process.execArgv, entry],
    ...(process.env.ELECTRON_RUN_AS_NODE !== undefined ? { env: { ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE } } : {}),
  };
}

export class MapOpsService {
  private readonly tokens = new Map<string, AgentMapContext>();
  private readonly turns = new Map<string, TurnSnapshot>();
  private daemonUrl: string | undefined;
  private readonly urlWaiters: ((url: string) => void)[] = [];

  constructor(
    private readonly host: () => MapOpsHost | undefined,
    private readonly options: MapOpsServiceOptions,
  ) {}

  /** The daemon's base URL once it listens (the stdio MCP server calls back into it). */
  setDaemonUrl(url: string): void {
    this.daemonUrl = url.replace(/\/+$/, "");
    for (const resolve of this.urlWaiters.splice(0)) resolve(this.daemonUrl);
  }

  // ---------- tokens ----------

  issueToken(ctx: AgentMapContext): string {
    const token = randomBytes(24).toString("base64url");
    this.tokens.set(hash(token), { ...ctx });
    return token;
  }

  contextForToken(token: string | undefined): AgentMapContext | undefined {
    if (token === undefined || token.length < 16) return undefined;
    return this.tokens.get(hash(token));
  }

  // ---------- tools for a bridge ----------

  /** The map tools one bridge (agent × project root) offers its agent. */
  toolsFor(ctx: AgentMapContext): AgentMapTools {
    const backend = this.backendFor(ctx);
    let token: string | undefined;
    return {
      instructions: MAP_SERVER_INSTRUCTIONS,
      allowedTools: sdkToolNames(),
      sdkServer: () => createMapSdkServer(backend, this.options.version),
      stdio: async (): Promise<StdioMcpServerSpec | undefined> => {
        const url = await this.waitForUrl(10_000);
        if (url === undefined) return undefined;
        token ??= this.issueToken(ctx);
        const launch = (this.options.launch ?? defaultLaunch)();
        return {
          name: MAP_SERVER_NAME,
          command: launch.command,
          args: [...launch.args, "mcp", "--daemon", url],
          // The token travels in the environment, not argv (argv shows in `ps`).
          env: [...Object.entries(launch.env ?? {}).map(([name, value]) => ({ name, value })), { name: "RUAH_MCP_TOKEN", value: token }],
        };
      },
    };
  }

  /** In-process backend (Claude Agent SDK tools, tests). */
  backendFor(ctx: AgentMapContext): MapBackend {
    return {
      read: async () => this.read(ctx),
      apply: (ops) => this.apply(ctx, ops),
    };
  }

  private waitForUrl(timeoutMs: number): Promise<string | undefined> {
    if (this.daemonUrl !== undefined) return Promise.resolve(this.daemonUrl);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), timeoutMs);
      timer.unref?.();
      this.urlWaiters.push((url) => {
        clearTimeout(timer);
        resolve(url);
      });
    });
  }

  // ---------- reads / writes ----------

  private storeFor(ctx: AgentMapContext): ArchitectureStore {
    const store = this.host()?.store ?? null;
    if (store === null) throw new MapOpsError(409, "no project is open in Ruah");
    if (store.root !== ctx.root) {
      throw new MapOpsError(409, `the project this agent works in (${ctx.root}) is not the one open in Ruah now (${store.root}); map changes are refused`);
    }
    return store;
  }

  read(ctx: AgentMapContext): { architecture: Architecture; revision: number } {
    const store = this.storeFor(ctx);
    const architecture = store.current();
    if (architecture === null) throw new MapOpsError(503, "the architecture is not loaded (architecture.json is invalid?)");
    return { architecture, revision: store.revision };
  }

  /** Applies `ops` atomically for the agent: one validation, one save, one broadcast. */
  async apply(ctx: AgentMapContext, ops: readonly ArchOp[]): Promise<ArchOpsResponse> {
    if (ops.length === 0) throw new MapOpsError(400, "no ops");
    const store = this.storeFor(ctx);
    const current = store.current();
    if (current === null) throw new MapOpsError(503, "the architecture is not loaded (architecture.json is invalid?)");
    let outcome;
    try {
      outcome = applyOps(current, ops, { origin: "agent", ...(store.resolvePath === undefined ? { root: store.root } : {}) });
    } catch (err) {
      if (err instanceof OpError) throw new MapOpsError(422, err.message);
      throw err;
    }
    if (outcome.changes.length === 0) {
      return { ok: true, revision: store.revision, results: outcome.results, changes: [], warnings: outcome.warnings };
    }
    const host = this.host();
    const turnId = host !== undefined && host.agentId() === ctx.agentId ? host.activeTurnId() : undefined;
    // Read → apply → save happen without an await in between (save validates and writes synchronously),
    // so two concurrent calls cannot lose each other's changes.
    const saving = store.save(outcome.architecture, {
      by: { kind: "agent", agentId: ctx.agentId, ...(turnId !== undefined ? { turnId } : {}) },
      changes: outcome.changes,
    });
    try {
      await saving;
    } catch (err) {
      throw new MapOpsError(422, `the map could not be saved: ${(err as Error).message}`);
    }
    if (turnId !== undefined) {
      const snap = this.turns.get(turnId);
      const after = store.current() ?? outcome.architecture;
      if (snap === undefined) {
        this.turns.set(turnId, { root: store.root, agentId: ctx.agentId, before: current, after, changes: [...outcome.changes] });
        this.trimTurns();
      } else {
        snap.after = after;
        snap.changes.push(...outcome.changes);
      }
      host?.recordMapChanges?.(turnId, outcome.changes);
    }
    return { ok: true, revision: store.revision, results: outcome.results, changes: outcome.changes, warnings: outcome.warnings };
  }

  private trimTurns(): void {
    const max = this.options.maxTurns ?? 30;
    while (this.turns.size > max) {
      const oldest = this.turns.keys().next().value;
      if (oldest === undefined) break;
      this.turns.delete(oldest);
    }
  }

  // ---------- undo ----------

  /** Whether `turnId` has map changes that can still be undone (this daemon's life). */
  undoable(turnId: string): boolean {
    return this.turns.has(turnId);
  }

  /**
   * Puts back what the turn's ops changed (three-way: elements the user
   * changed again since are left alone and listed in `skipped`).
   */
  async undoTurn(turnId: string): Promise<{ changes: MapChange[]; skipped: string[] }> {
    const snap = this.turns.get(turnId);
    if (snap === undefined) throw new MapOpsError(404, "nothing to undo for this turn (map changes can be undone until Ruah restarts)");
    const store = this.host()?.store ?? null;
    if (store === null || store.root !== snap.root) throw new MapOpsError(409, "open the project this turn belongs to first");
    const current = store.current();
    if (current === null) throw new MapOpsError(503, "the architecture is not loaded");
    const { architecture, changes, skipped } = revertTurn(current, snap.before, snap.after);
    this.turns.delete(turnId);
    if (changes.length === 0) {
      throw new MapOpsError(409, skipped.length > 0 ? `nothing undone: you changed ${skipped.slice(0, 3).join(", ")} since` : "nothing left to undo");
    }
    try {
      await store.save(architecture, { by: { kind: "user", turnId, undo: true }, changes });
    } catch (err) {
      this.turns.set(turnId, snap);
      throw new MapOpsError(422, `undo failed: ${(err as Error).message}`);
    }
    return { changes, skipped };
  }
}
