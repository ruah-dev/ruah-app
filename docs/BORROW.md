# BORROW.md — what to take from T3 Code, and the license terms

Clone inspected: `./t3code`, origin `https://github.com/pingdotgg/t3code.git`, HEAD `eff44be4` (2026-09-16), package `@t3tools/monorepo`. This is the upstream, not a fork (I cloned it fresh because no local clone existed; see ASSUMPTIONS.md).

## 1. The finding that reframes this list

**T3 Code does not drive Claude Code over ACP.** Its Claude provider (`apps/server/src/provider/Layers/ClaudeAdapter.ts`, 5,589 lines, plus `Drivers/ClaudeDriver.ts`) wraps `@anthropic-ai/claude-agent-sdk` `query()` directly, with `includePartialMessages: true` for streaming and a `canUseTool` callback for permissions. Codex uses its own app-server protocol (`packages/effect-codex-app-server`). ACP is used for three providers only: Cursor (`Layers/CursorAdapter.ts`), Grok (`Layers/GrokAdapter.ts`), and Antigravity (`Drivers/AntigravityDriver.ts`, `Layers/AntigravityAdapter.ts`).

Consequence: the "Claude Code preset as an ACP agent" the brief expected does not exist in t3code. The ACP client code is agent-agnostic, so it still teaches us the client side. For the agent side we use `@agentclientprotocol/claude-agent-acp` (0.78.0, Apache-2.0, ACP registry id `claude-acp`, authors Anthropic / Zed / JetBrains). I ran its handshake on this machine: `initialize` in 159 ms, `session/new` in ~700 ms, existing Claude Max login picked up automatically, modes `default | acceptEdits | plan | auto | bypassPermissions`.

**T3 Code's ACP client is Effect-TS.** `packages/effect-acp` is built on `effect/unstable/rpc` (RpcClient/RpcServer), `effect/Schema`, `effect/Stdio`, and `effect/unstable/process/ChildProcessSpawner`, with a 10k-line generated schema. Porting files verbatim means adopting Effect. Recommendation: port the decisions listed below, and let `@agentclientprotocol/sdk` 1.4.0 (`client()`, `ndJsonStream`, `ActiveSession`) do the wire layer. Nothing below is copied byte-for-byte unless marked **copy**.

## 2. Borrow list

Verdicts: **copy** (take the code, keep attribution), **adapt** (re-implement the behaviour without Effect), **read** (learn from it, write our own), **drop**.

### 2.1 ACP client layer (`packages/effect-acp/src/`)

| Item | File(s) | Verdict | What we take |
| --- | --- | --- | --- |
| Client method surface | `client.ts` L59–288 (`AcpClient` service: `agent.initialize/authenticate/createSession/loadSession/prompt/cancel`, `handleRequestPermission`, `handleSessionUpdate`, `handleExtRequest/Notification`) | read | Our `AcpBridge` exposes the same small surface: `start()`, `prompt()`, `cancel()`, `setMode()`, `onPermission()`, `onUpdate()`, `onTerminated()`. Everything else (terminals, elicitation, fs, fork/list/resume) is left out. |
| Buffer notifications that arrive before a handler is attached | `client.ts` L320–378 (`BufferedNotificationHandler`, `flushBufferedNotifications`) | adapt | The Claude adapter emits `available_commands_update` and `_auth/status_update` right after `session/new`. SDK `ActiveSession` queues updates per session id; extension notifications must be ignored, not treated as errors. |
| Drop `Interrupt` frames; ACP has no interrupt method | `protocol.ts` L129–133 | read | Never send anything but `initialize`, `session/*`, `authenticate`. Cancellation is only `session/cancel`. |
| Request-id namespace split (client requests start at 2^32 so they cannot collide with the agent's ids) | `client.ts` L479–482 | drop | SDK handles ids. |
| On process exit: fail every pending request once, emit one termination event, stop accepting writes | `protocol.ts` L209–236 (`handleTermination`), `_internal/stdio.ts` L663–675 (`makeTerminationError`: exit code → error) | adapt | `AgentProcess` listens to `child.on("exit")`, rejects pending permission promises, marks the bridge `stopped`, emits one `agent.status{state:"error"}`. Daemon respawns once, then stays in `error` until `session.reset`. |
| Sliding raw-notification queue (32) | `protocol.ts` L86, L103 | drop | Not needed with one consumer. |
| Error taxonomy | `errors.ts` (`AcpSpawnError`, `AcpProcessExitedError`, `AcpProtocolParseError`, `AcpTransportError`, `AcpInputStreamEndedError`, `AcpRequestError` with JSON-RPC codes -32700/-32600/-32601/-32602/-32603, -32000 auth required, -32002 resource not found) | adapt | Collapse to the WS `ErrorCode` set in CONTRACTS.md §2.1: `agent_spawn_failed`, `agent_exited`, `agent_protocol`, `agent_request_failed`. Keep the JSON-RPC `code` in `message`. |
| Generated schema + RPC groups | `_generated/schema.gen.ts`, `rpc.ts`, `agent.ts`, `terminal.ts`, `scripts/generate.ts` | drop | SDK ships `schema/types.gen.d.ts` and zod guards. |
| Mock ACP peer for tests | `test/fixtures/acp-mock-peer.ts`, `client.test.ts` | read | Write a 100-line fake agent (`test/fake-agent.ts`) speaking ndjson over stdio using SDK `agent()`; scripted turns: text only, text + read tool, edit needing permission, cancel mid-turn, crash mid-turn. |

### 2.2 Session runtime (`apps/server/src/provider/acp/`)

| Item | File(s) | Verdict | What we take |
| --- | --- | --- | --- |
| Spawn with `cwd`, merged env, stderr captured and capped (32 KiB per chunk), stderr forwarded to logs | `AcpSessionRuntime.ts` L70, L425–466 | adapt | `AgentProcess.spawn(preset, {cwd, env})`; keep a 64 KiB stderr ring buffer; include the tail in `agent_exited` errors. The Claude adapter logs structured lines to stderr (`[session/create] … phase=sdk-initialize durationMs=657`), so we can surface timings. |
| Startup sequence `initialize → authenticate (only if authMethods non-empty) → session/new`; capability payload with explicit `fs:{readTextFile:false,writeTextFile:false}, terminal:false` | `AcpSessionRuntime.ts` L566–578, L695–721, L830–866 | adapt | Same order. `clientInfo: { name: "archmap", version }`. Phase 1 advertises no fs/terminal capabilities (verified the adapter still runs its own tools). |
| Startup-metadata buffering: mode/config/commands updates that arrive while "Starting" are replayed once "Started" | `AcpSessionRuntime.ts` L68, L490–520, L866–905 | adapt | Record `modes` from `NewSessionResponse`; apply `current_mode_update` whenever it arrives. |
| Ignore updates whose `sessionId` ≠ ours, and `_meta.isReplay === true` updates | `AcpSessionRuntime.ts` L521–531, `AcpRuntimeModel.ts` L697–700 | adapt | One line each. Subagent sessions and replays otherwise leak into the stream. |
| One active prompt (two semaphores: serialization + dispatch) and a `dispatched` deferred so a `cancel` can target the prompt that is actually in flight | `AcpSessionRuntime.ts` L317–320, L937–1060 | adapt | `AcpBridge.prompt()` throws `busy` if a turn is active; `cancel()` reads the active turn from one field. No queueing in Phase 1. |
| Cancel semantics: send `session/cancel`, wait for the prompt response with a timeout (15 s), on timeout kill the process (`forceKillAfter: 1 s`) and report | `AcpSessionRuntime.ts` L67, L936–970 | **copy** (constants + order) | CONTRACTS §2.2 rule 5 is this behaviour. Also answer pending `session/request_permission` with `cancelled` first (the SDK docs say the client MUST). |
| Assistant "segments": a tool call closes the current text item, the next text chunk opens a new item; item ids = `${runtimeId}:${segmentIndex}` with `runtimeId` a fresh UUID per process | `AcpSessionRuntime.ts` L307–316, L1249–1312; commit `bcd640bf4` "prevent ACP assistant ID collisions after restarts" | adapt | Viewer-side: the `stream.tool_call` event closes the current text bubble. Daemon does not need item ids in Phase 1. |
| Session-load replay gate (wait 2 s idle, 90 s timeout) | `AcpSessionRuntime.ts` L65–66, L725–830; commit `52b04b947` | drop | We never `session/load` in Phase 1–3. If resume is added, copy this. |
| Config options and `session/set_config_option` plumbing (mode is a config option `"mode"` on some agents) | `AcpSessionRuntime.ts` L592–690, L1061–1075 | drop | Use `session/set_mode`. The Claude adapter exposes modes both ways; set_mode is the spec path. |

### 2.3 Event normalisation (`apps/server/src/provider/acp/AcpRuntimeModel.ts`, `AcpCoreRuntimeEvents.ts`)

| Item | File(s) | Verdict | What we take |
| --- | --- | --- | --- |
| `parseSessionUpdateEvent`: the switch over `sessionUpdate` (`config_option_update`, `available_commands_update`, `current_mode_update`, `plan`, `tool_call`, `tool_call_update`, `agent_message_chunk`, `agent_thought_chunk`; default ignored) | `AcpRuntimeModel.ts` L787–887 | adapt | This is `src/acp/normalize.ts`. Output is `StreamEvent` from CONTRACTS §2.1. Empty text chunks are skipped (`text.trim().length === 0` guard, L1211). |
| `mergeToolCallState`: `tool_call_update` carries partial fields; merge onto the tracked state keyed by `toolCallId`; delete on completed/failed | `AcpRuntimeModel.ts` L564–596; `AcpSessionRuntime.ts` L1172–1207 | adapt | Keep a `Map<toolCallId, ToolCallView>` per turn. |
| `decideToolCallUpdateEmission` + `toolCallProgressLength`: coalesce noisy in-progress updates | `AcpRuntimeModel.ts` L597–667 | drop for Phase 1 | Revisit if the viewer stutters. AGENTS.md lists "too much data over websockets" as their most common perf regression. |
| `boundToolCallRawOutput`: cap raw output fields | `AcpRuntimeModel.ts` L302–320 | adapt | `ToolCallView.output` capped at 4 KiB. `rawInput`/`rawOutput` are not forwarded at all. |
| `extractToolCallCommand`: derive a display command from `rawInput.command` / `executable + args` | `AcpRuntimeModel.ts` L264–301 | adapt | Fills `ToolCallView.command` for `kind === "execute"`. |
| `canonicalItemTypeFromAcpToolKind`, `canonicalRequestTypeFromAcpKind` | `AcpRuntimeModel.ts` L452–466, `AcpCoreRuntimeEvents.ts` L38–51 | read | We keep ACP `ToolKind` verbatim in the WS contract; the viewer maps kind → icon. |
| `parsePermissionRequest`: detail = command ?? title ?? fallback | `AcpRuntimeModel.ts` L668–695 | adapt | Same for `permission.request.toolCall`. |
| Event shapes `request.opened / request.resolved / item.updated / item.completed / content.delta` | `AcpCoreRuntimeEvents.ts` | read | Inspired the WS `permission.request / permission.resolved / stream.tool_call / stream.tool_result / stream.text` split. |

### 2.4 Permissions and provider wiring (`apps/server/src/provider/Layers/CursorAdapter.ts`, `acp/AcpAdapterSupport.ts`)

| Item | File(s) | Verdict | What we take |
| --- | --- | --- | --- |
| Pending-approval map keyed by request id holding a deferred; handler emits `request.opened`, awaits the decision, emits `request.resolved`, returns the ACP outcome | `CursorAdapter.ts` L519–523, L681–757 | adapt | `Map<requestId, {resolve, reject, turnId}>` in `AcpBridge`. |
| Full-access auto-approve: pick the first `allow_always`/`allow_once` option when the mode says so | `CursorAdapter.ts` L688–697 (`selectAutoApprovedPermissionOption`) | adapt | Used by `archmap scan --describe` with a read-only policy (auto-allow `read/search/think`, auto-reject everything else) and by a `--yolo` flag on `serve`. |
| `acpPermissionOutcome` hard-codes option ids `allow-always` / `allow-once` / `reject-once` | `AcpAdapterSupport.ts` L45–56; commit `99d91ddaa` "keep unknown approvals actionable" | **do not port** | Option ids are agent-defined. The Claude adapter builds them per tool (`buildClaudePermissionOptions`). Relay `options[]` verbatim and send back the chosen `optionId`. |
| `mapAcpToAdapterError`: process-exited → "session closed", everything else → request error with method | `AcpAdapterSupport.ts` L17–43 | adapt | Same two buckets. |
| Passing the host's own MCP server to the agent via `session/new.mcpServers` (`{ type: "http", name, url, headers: [Authorization] }`) | `CursorAdapter.ts` L563–577 | read | Phase 3: `archmap mcp` can be handed to the agent this way, so `get_architecture` / `get_node` are native tools without a separate MCP config. |
| Provider "instance" = `{ binaryPath, args, env, cwd }` with per-instance isolation; `CLAUDE_CONFIG_DIR` for separate accounts | `ProviderDriver.ts`, `docs/user/providers-claude.md` | read | `src/acp/presets.ts`: one preset `claudeCode = { command: process.execPath, args: [resolve("@agentclientprotocol/claude-agent-acp/dist/index.js")], env: passthrough(CLAUDE_CONFIG_DIR, ANTHROPIC_*, CLAUDE_CODE_EXECUTABLE) }`. Spawning the resolved JS with `process.execPath` avoids `npx` resolution latency and the Windows `.cmd` shim problem below. |
| Windows: `.cmd/.bat/.ps1` shims cannot be spawned without a shell since Node 20.12 (`spawn EINVAL`); resolve to the real entry file | `Drivers/ClaudeExecutable.ts` L14–60 | read | Same rule for our preset. |
| Mode naming for the UI: Supervised / Auto-accept edits / Auto / Full access | `docs/user/permission-modes.md` | read | Map to Claude adapter ids `default / acceptEdits / auto / bypassPermissions` (+ `plan`). |

### 2.5 Lessons from commit history and docs (things they learned the hard way)

| Lesson | Evidence | Applied where |
| --- | --- | --- |
| Do not create sessions or spawn agents from health checks or timers; a session start runs MCP servers and hooks | `docs/internals/providers.md` "Setup must not happen as a health-check side effect"; commit `8c18b5bb2` (health probe filled the disk) | Daemon spawns exactly one agent at `serve` start and never re-probes. |
| Capabilities must describe what the client actually does | `docs/internals/providers.md` "Capabilities must describe what the provider can actually do" | We advertise `fs`/`terminal` false until implemented. |
| Native option ids must survive normalisation; a label is not a valid reply | same doc, "Protocol traps" | CONTRACTS §2.1 `PermissionOption.optionId` is opaque. |
| Stale approval responses (answer after the turn ended) must be tolerated | commit `77f67d176`; `CursorAdapter.ts` pending map deletion | `permission.response` for an unknown request → `error{no_turn}`, not a crash. |
| Cap diagnostics: params sliced to 2,000 chars, stderr chunks to 32 KiB | commit `d53237cbd`; `CursorAdapter.ts` L722 | Log sizes bounded; never log full tool outputs. |
| Structure transport errors so the UI can distinguish "agent died" from "request failed" | commit `4c16c6636` | WS `ErrorCode` set. |
| Unique assistant item ids across restarts | commit `bcd640bf4` | Viewer keys messages by `turnId` + sequence, never by agent ids. |
| Too much data over the WebSocket is the most common perf regression | `AGENTS.md` "Performance without compromise" | Output cap, no raw payloads, coalescing as a Phase 3 option. |

### 2.6 Explicitly dropped

`apps/desktop` (Electron), `apps/mobile`, `apps/web` (their UI), `apps/server/src/usage`, `orchestration/` (event sourcing), `checkpointing/`, `relay/`, T3 Connect, provider registry / multi-instance settings, Codex app-server, OpenCode, terminal runtime, `packages/client-runtime`.

## 3. License findings

### 3.1 T3 Code

`t3code/LICENSE` is the MIT License, `Copyright (c) 2026 T3 Tools Inc.`. Not copyleft. Conditions: the copyright notice and the permission notice must be included in all copies or substantial portions of the Software.

What this means for us:

- Code we **copy** or **adapt** closely (currently: the cancel sequence and constants, the tool-call merge logic, the permission map pattern) must carry attribution.
- Design knowledge (**read** items) does not require attribution, but we credit it anyway in `THIRD_PARTY_NOTICES.md`.
- No obligation to open-source archmap, no obligation to use the same license.

Add to the daemon repo:

1. `THIRD_PARTY_NOTICES.md` containing:

   ```
   Portions of this software are derived from T3 Code
   https://github.com/pingdotgg/t3code
   Copyright (c) 2026 T3 Tools Inc.
   Licensed under the MIT License, reproduced below.

   <full MIT text from t3code/LICENSE>
   ```

2. A header comment in every file that adapts t3code logic:

   ```ts
   // Adapted from T3 Code (https://github.com/pingdotgg/t3code),
   // apps/server/src/provider/acp/AcpSessionRuntime.ts. Copyright (c) 2026 T3 Tools Inc. MIT License.
   ```

3. If archmap is published under MIT too, keep our own `LICENSE` and the notices file side by side. If published under Apache-2.0, the MIT notice still travels in `THIRD_PARTY_NOTICES.md`.

### 3.2 Other components we depend on

| Component | Version | License | Obligation |
| --- | --- | --- | --- |
| `@agentclientprotocol/sdk` | 1.4.0 | Apache-2.0 | If we bundle it (tsup/esbuild), preserve its license header and add it to `THIRD_PARTY_NOTICES.md`. As a plain npm dependency: nothing extra. |
| `@agentclientprotocol/claude-agent-acp` | 0.78.0 | Apache-2.0 per its `LICENSE` file in the npm package. The ACP registry metadata says `"license": "proprietary"` — a metadata inconsistency; the shipped file is Apache-2.0. | We spawn it as a dependency, never bundle or modify it. Nothing extra. |
| `@anthropic-ai/claude-agent-sdk` (transitive, pulled by the adapter) | 0.3.270 | Proprietary Anthropic terms (`LICENSE.md`: "Use is subject to the Legal Agreements … code.claude.com/docs/en/legal-and-compliance") | Installed on the user's machine, runs against the user's Claude account. Do not bundle, vendor, or redistribute it. |

### 3.3 Clean-room alternative (not needed)

Since t3code is MIT, no clean-room rewrite is required. If you prefer zero derivation anyway, the SDK-only path is: `client()` + `ndJsonStream` + `ActiveSession` from `@agentclientprotocol/sdk`, with the cancel/permission behaviour written from the ACP spec text (prompt-turn and tool-calls pages) rather than from t3code. Every item marked **adapt** above is small enough (10–80 lines) that this costs roughly one extra day.
