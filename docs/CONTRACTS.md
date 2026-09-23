# CONTRACTS.md — archmap coupling contracts

These three contracts are the only coupling between the Lovable viewer ("Architect's Canvas") and the daemon (`archmap`). Both sides copy the TypeScript types verbatim and validate at the boundary with zod. Nothing else crosses the wire.

Written 2026-09-16 against ACP `protocolVersion: 1`, `@agentclientprotocol/sdk` 1.4.0, `@agentclientprotocol/claude-agent-acp` 0.78.0.

Conventions that apply to all three contracts:

- Paths are repo-relative, POSIX separators, no leading `./`, no trailing `/`. The only absolute path on the wire is `root` in the `architecture` message. ACP itself requires absolute paths; the daemon converts in both directions.
- IDs match `^[a-z0-9][a-z0-9._-]{0,63}$`.
- Timestamps are ISO 8601 UTC.
- Receivers ignore unknown fields and unknown `type`/`kind` values instead of rejecting the message.
- Strings are UTF-8, newlines are `\n`.

---

## 1. `architecture.json`

The file lives at `<repo>/architecture.json` (override with `archmap serve --file`). The daemon reads, validates, watches, and serves it. The viewer never reads it from disk.

### 1.1 Types

```ts
export type NodeType =
  | "service" | "module" | "datastore" | "external" | "step" // from the brief
  | "frontend" | "gateway" | "queue" | "file"                // added: the viewer already styles these kinds
  | (string & {});                                          // open; unknown types render as "module"

export interface ArchNode {
  id: string;
  type: NodeType;
  name: string;
  description?: string; // 1–2 sentences, <= 400 chars. Copied verbatim into the context pack.
  notes?: string;       // user-authored, markdown allowed, any length. Context pack takes the first 600 chars.
  tech?: string[];      // e.g. ["Node 22", "Express", "Postgres"]
  path?: string;        // directory or file. The node's address in the repo.
  files?: string[];     // <= 20 entries, most relevant first. Context pack lists the first 12.
  layer?: string;       // must appear in Architecture.layers
  parent?: string;      // id of the containing node. Absent = top level. Enables drill-down.
  x?: number;           // canvas units (px at zoom 1). Daemon fills both when missing; viewer never lays out.
  y?: number;
}

export interface ArchEdge {
  from: string;         // node id
  to: string;           // node id
  label?: string;       // <= 40 chars, rendered on the edge
  kind?: "sync" | "async" | "event" | "data" | (string & {});
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  steps: string[];      // node ids in order, >= 2 entries. Consecutive steps are drawn as arrows.
}

export interface Architecture {
  version: 1;
  name: string;         // display name, usually the repo directory name
  generatedBy?: string; // e.g. "archmap scan 0.1.0"
  generatedAt?: string;
  layers?: string[];    // drawn as labelled groups; order = drawing order
  nodes: ArchNode[];
  edges: ArchEdge[];
  workflows: Workflow[];
}
```

Extensions over the brief, each needed by the existing viewer or the scanner: `version`, `name`, `generatedBy`, `generatedAt`, the four extra `NodeType` values, `parent`, `x`, `y`, `Workflow.description`.

### 1.2 Validation rules (daemon rejects the file, keeps the last good version, and sends `architecture.error`)

1. `version === 1`.
2. Node ids unique. Edge `from`/`to`, `parent`, and workflow `steps` reference existing node ids.
3. `parent` chains are acyclic.
4. `node.layer` appears in `layers` when `layers` is present.
5. `path` and `files[]` are repo-relative and stay inside the repo after normalisation (`..` rejected).
6. Self-edges (`from === to`) are rejected. Duplicate `(from, to, label)` triples are rejected.
7. Workflow `steps.length >= 2`.

Warnings (logged, not rejected): `description` over 400 chars, `files` over 20, `path` that does not exist on disk.

### 1.3 How the viewer maps this onto its existing model

The viewer keeps its internal `DiagramNode`/`Graph` types in `src/data/graphs.ts` and adds a pure mapper `toGraph(architecture, parentId | null)`:

| `architecture.json` | Viewer today (`src/data/graphs.ts`) | Mapping |
| --- | --- | --- |
| `node.type` | `DiagramNode.kind` | `datastore -> "database"`; `service, queue, external, frontend, gateway, module, file, step` map 1:1; anything else -> `"module"` |
| `node.name` | `label` | as is |
| `node.tech`, `node.path` | `subtitle` | `tech.slice(0,2).join(" · ")`, else `path`, else empty |
| `node.parent` | separate `graphs[...]` + `drill` | graph shown = nodes whose `parent` equals the current level (`null` = root). `drill` = node has children. Breadcrumb stack holds node ids instead of graph ids. |
| `node.layer` + `layers[]` | `groups[]` with x/y/w/h | one group per layer, box = bounding box of member nodes at this level + 24 px padding |
| `edge.kind` | `DiagramEdge.animated` | `async` or `event` -> animated |
| `edges` | per-graph edges | show edges whose both ends are visible at the current level |
| `workflows[].steps` | `workflow-*` graphs | "Workflows" mode lists workflows; selecting one shows its step nodes in order with sequential arrows |
| `node.files[]` (paths) | `files: CodeFile[]` with inline `code` | Code tab fetches `GET /api/file?path=` |
| `node.path` + `node.files` | hard-coded `repoTree` | tree derived from all `path`/`files` values; leaf click selects the node |
| not present | `owner`, `endpoints`, `health` | dropped; the components already hide these sections when absent |

### 1.4 Example

```json
{
  "version": 1,
  "name": "acme-platform",
  "generatedBy": "archmap scan 0.1.0",
  "generatedAt": "2026-09-16T10:00:00Z",
  "layers": ["clients", "edge", "services", "data", "third-party"],
  "nodes": [
    { "id": "web", "type": "frontend", "name": "web-app", "layer": "clients",
      "path": "apps/web", "tech": ["React 19", "TanStack Router"],
      "description": "Customer-facing dashboard. Renders invoices, billing and org settings.",
      "files": ["apps/web/src/routes/invoices.tsx", "apps/web/src/lib/api-client.ts"] },
    { "id": "gateway", "type": "gateway", "name": "api-gateway", "layer": "edge",
      "path": "infra/gateway", "tech": ["Envoy"],
      "description": "Terminates TLS, validates JWTs and routes /v1/* to services." },
    { "id": "api", "type": "service", "name": "invoices-api", "layer": "services",
      "path": "services/invoices-api", "tech": ["Node 22", "Express", "Zod"],
      "description": "Core business service. Handles invoice CRUD, validation and emits domain events.",
      "notes": "Validation lives in routes/, not in the service layer. Known flaky: currency enum.",
      "files": [
        "services/invoices-api/src/app.ts",
        "services/invoices-api/src/routes/invoices/invoices.routes.ts",
        "services/invoices-api/src/routes/invoices/invoices.service.ts",
        "services/invoices-api/src/repositories/invoices.repo.ts"
      ] },
    { "id": "api-routes", "type": "module", "name": "routes", "parent": "api",
      "path": "services/invoices-api/src/routes",
      "description": "Express routers and Zod request schemas." },
    { "id": "api-repo", "type": "module", "name": "repositories", "parent": "api",
      "path": "services/invoices-api/src/repositories",
      "description": "SQL access. Only place that writes invoices." },
    { "id": "db", "type": "datastore", "name": "postgres", "layer": "data",
      "tech": ["Postgres 16"], "description": "Primary relational store." },
    { "id": "bus", "type": "queue", "name": "events-bus", "layer": "data",
      "tech": ["SQS"], "description": "Durable pub/sub for invoice.* topics." },
    { "id": "stripe", "type": "external", "name": "Stripe", "layer": "third-party",
      "description": "Payment provider." },
    { "id": "w-validate", "type": "step", "name": "Validate", "description": "Zod schema check." },
    { "id": "w-persist", "type": "step", "name": "Insert row" }
  ],
  "edges": [
    { "from": "web", "to": "gateway", "label": "REST", "kind": "sync" },
    { "from": "gateway", "to": "api", "label": "/v1/invoices", "kind": "sync" },
    { "from": "api", "to": "db", "label": "sql", "kind": "data" },
    { "from": "api", "to": "bus", "label": "invoice.created", "kind": "event" },
    { "from": "api", "to": "stripe", "label": "charge", "kind": "sync" },
    { "from": "api-routes", "to": "api-repo", "label": "calls", "kind": "sync" }
  ],
  "workflows": [
    { "id": "create-invoice", "name": "Create invoice", "description": "POST /v1/invoices end to end",
      "steps": ["web", "gateway", "api", "w-validate", "w-persist", "db", "bus"] }
  ]
}
```

---

## 2. Viewer ↔ daemon WebSocket protocol

Transport: one WebSocket at `ws://<host>/ws` (default `ws://127.0.0.1:4177/ws`). Every frame is one JSON object with a `type` field. The viewer connects, sends `hello`, and the daemon immediately answers with `architecture` and `agent.status`. One turn at a time per daemon.

### 2.1 Types

```ts
// ---------- viewer -> daemon ----------
export type ClientMessage =
  | { type: "hello"; protocol: 1; client: string }                        // first frame. client = "architects-canvas/<version>"
  | { type: "architecture.get" }                                          // re-request current file
  | { type: "focus.set"; nodeId: string | null }                          // selection changed (daemon logs it; MCP exposes it)
  | { type: "prompt"; turnId: string; nodeId: string; text: string }      // turnId: viewer-generated UUID
  | { type: "permission.response"; requestId: string; optionId: string }  // optionId must be one of the offered options
  | { type: "permission.response"; requestId: string; cancelled: true }   // user dismissed
  | { type: "cancel"; turnId: string }
  | { type: "session.reset" }                                             // Phase 3: new ACP session (drops agent memory)
  | { type: "mode.set"; modeId: string }                                  // Phase 3: session/set_mode
  | { type: "model.set"; modelId: string }                                // switch model for the live session
  | { type: "agent.set"; agentId: string }                                // switch coding agent: stops the current one (cancelling any turn), starts the new one with a fresh session
  | { type: "architecture.save"; architecture: Architecture };            // Phase 3: daemon validates + writes the file

// ---------- daemon -> viewer ----------
export type ServerMessage =
  | { type: "architecture"; reason: "initial" | "changed" | "saved"; revision: number;
      root: string; path: string; architecture: Architecture }            // root = absolute repo dir on the daemon host
  | { type: "architecture.error"; path: string; message: string }         // file invalid; previous revision stays live
  | { type: "agent.status"; state: AgentState; agent?: { name: string; version: string };
      sessionId?: string; modes?: ModeState; models?: ModelState; agents?: AgentChoiceState; error?: string }
  | { type: "turn.started"; turnId: string; nodeId: string; contextPack: string; text: string }
  | { type: "stream"; turnId: string; event: StreamEvent }
  | { type: "permission.request"; turnId: string; requestId: string;
      toolCall: ToolCallView; options: PermissionOption[] }
  | { type: "permission.resolved"; turnId: string; requestId: string; optionId?: string; cancelled?: true }
  | { type: "turn.finished"; turnId: string; stopReason: StopReason; error?: string }
  | { type: "error"; code: ErrorCode; message: string; turnId?: string; requestId?: string; fatal?: boolean };

export type AgentState = "starting" | "idle" | "busy" | "error" | "stopped";
export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" | "error";

export interface ModeState {
  currentModeId: string;                                         // Claude adapter: "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions"
  available: { id: string; name: string; description?: string }[];
}

export interface AgentChoiceState {
  currentAgentId: string;                                        // "claude" (Claude Agent SDK) | "cursor" | "grok" | "kiro" (ACP)
  available: { id: string; name: string; installed: boolean; description?: string; installHint?: string }[];
}

export interface ModelState {
  currentModelId: string;                                        // e.g. "default", "opus", "sonnet", "haiku" (agent-defined ids)
  available: { id: string; name: string; description?: string }[];
}

export type StreamEvent =
  | { kind: "text"; text: string }                    // ACP agent_message_chunk with text content, forwarded per chunk
  | { kind: "thought"; text: string }                 // ACP agent_thought_chunk
  | { kind: "tool_call"; toolCall: ToolCallView }     // ACP tool_call, or tool_call_update while status is pending/in_progress
  | { kind: "tool_result"; toolCall: ToolCallView }   // ACP tool_call_update whose merged status is completed/failed
  | { kind: "diff"; toolCallId: string; path: string; oldText: string | null; newText: string } // ACP ToolCallContent type "diff"
  | { kind: "plan"; entries: PlanEntry[] };           // ACP plan; replaces the whole plan

export interface ToolCallView {
  toolCallId: string;
  title: string;
  kind: "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";
  status: "pending" | "in_progress" | "completed" | "failed";
  locations: { path: string; line?: number }[];      // repo-relative when inside root, else absolute
  command?: string;                                  // rawInput.command when kind === "execute"
  output?: string;                                   // concatenated text content, capped at 4096 chars, suffix " …[truncated]"
}

export interface PlanEntry { content: string; priority: "high" | "medium" | "low"; status: "pending" | "in_progress" | "completed" }

export interface PermissionOption {
  optionId: string;                                  // opaque, relay verbatim
  name: string;                                      // button label
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export type ErrorCode =
  | "bad_message"          // frame failed validation
  | "save_rejected"        // architecture.save failed validation or could not be written
  | "unknown_node"         // prompt.nodeId not in current architecture
  | "busy"                 // a turn is active; prompt rejected
  | "no_turn"              // cancel/permission.response for an unknown turn or request
  | "agent_spawn_failed"   // fatal
  | "agent_exited"         // fatal until the daemon respawns (it retries once)
  | "agent_protocol"       // malformed ACP traffic
  | "agent_request_failed" // ACP JSON-RPC error on initialize/session/prompt
  | "internal";
```

### 2.2 Rules

1. `hello` first. Any other frame before `hello` → `error{bad_message}` and the socket is closed.
2. Daemon → viewer after `hello`: `architecture{reason:"initial"}` then `agent.status`. `agent.status` is re-sent on every state change.
3. `prompt` is accepted only when `agent.status.state === "idle"`. Otherwise `error{busy, turnId}`. Accepted prompts produce `turn.started` (carrying the exact context pack that was sent, for transparency) and then `stream` events until `turn.finished`.
4. `permission.request` blocks the agent until `permission.response` arrives. There is no daemon-side timeout in Phase 1. `permission.resolved` is echoed so a second viewer tab stays consistent.
5. `cancel` makes the daemon (a) answer every pending `permission.request` of that turn with ACP `{outcome:"cancelled"}`, (b) send ACP `session/cancel`, (c) wait up to 15 s for the ACP prompt response, then `turn.finished{stopReason:"cancelled"}`. If the agent does not respond in 15 s the daemon kills and respawns it and sends `turn.finished{stopReason:"error"}` + `agent.status`.
6. Viewer disconnect during a turn = `cancel`. (Phase 3: keep the turn, buffer the last turn's events, replay on reconnect.)
7. `stream{kind:"text"}` chunks are forwarded as they arrive, no batching. The viewer appends them to the current assistant segment. A `tool_call` event closes the current text segment; the next text chunk opens a new one (matches t3code's assistant segmentation).
8. `tool_call` / `tool_result` carry the full merged state, so the viewer upserts by `toolCallId`.
9. `diff` is emitted in addition to the `tool_call`/`tool_result` that contained it, so the viewer can render diffs without parsing tool content.
10. The daemon only listens on `127.0.0.1` by default and checks the `Origin` header: `http(s)://localhost:*`, `http(s)://127.0.0.1:*`, plus `--allow-origin <glob>` (needed for Lovable previews, e.g. `https://*.lovable.app`).
11. Frames larger than 1 MiB are rejected with `bad_message`.

### 2.3 Companion HTTP endpoints (same origin as the WebSocket)

| Method + path | Purpose | Notes |
| --- | --- | --- |
| `GET /` and any non-`/api` path without an extension | viewer `index.html` (SPA fallback) | static dir from `--viewer <dir>`, default bundled |
| `GET /assets/*` | viewer assets | `Cache-Control: public, max-age=31536000, immutable` |
| `GET /api/health` | `{ ok: true, version, agent: AgentState }` | |
| `GET /api/architecture` | current `Architecture` JSON | same payload as the WS message |
| `GET /api/context/:nodeId` | `text/plain` context pack for the node | used by "Copy context" in the node popover |
| `GET /api/file?path=<rel>` | `{ path, lang, content }` | inside root only; max 512 KiB; binary → 415; missing → 404 |
| `PUT /api/architecture` | Phase 3, same as `architecture.save` | body validated, written atomically |
| `POST /api/rescan` | re-run the scanner on the served repo, merging hand edits; `{ ok, nodes, edges, layers, ms }` | Origin checked like `/ws` (403 otherwise); result is broadcast as `architecture` reason `saved`; 422 if the result fails validation |
| `GET /api/usage/summary?range=24h\|7d\|30d` | `{ range, totals: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd: number\|null, turns }, series: { t, agentId, model, inputTokens, outputTokens, costUsd\|null }[], byModel: { agentId, model, turns, inputTokens, outputTokens, costUsd\|null }[] }` | per-turn usage recorded by the daemon in `~/.ruah/usage.jsonl` (all repos); `t` = ISO bucket start (hourly for 24h, daily otherwise); `costUsd` only when the agent reports it |
| `GET /api/usage/limits` | `{ providers: { agentId, name, status: "available"\|"unavailable"\|"unknown", windows: { id, label, kind: "session"\|"weekly"\|"other", usedPercent: number\|null, resetsAt: string\|null }[], note? }[] }` | Claude: SDK `get_usage` + streamed `rate_limit_event` (port of t3code `claudeUsageLimits.ts`); other agents `unknown` unless their ACP usage updates say otherwise |

### 2.4 Example: one complete turn

```json
{"type":"hello","protocol":1,"client":"architects-canvas/0.1.0"}
```
```json
{"type":"architecture","reason":"initial","revision":3,"root":"/Users/petre/code/acme-platform","path":"/Users/petre/code/acme-platform/architecture.json","architecture":{"version":1,"name":"acme-platform","nodes":[],"edges":[],"workflows":[]}}
{"type":"agent.status","state":"idle","agent":{"name":"@agentclientprotocol/claude-agent-acp","version":"0.78.0"},"sessionId":"b446fcb7-2900-4ab8-aa24-a2f428210c32","modes":{"currentModeId":"default","available":[{"id":"default","name":"Manual","description":"Always ask before making changes"},{"id":"acceptEdits","name":"Accept edits","description":"Automatically accept all file edits"},{"id":"plan","name":"Plan","description":"Create a plan before making changes"},{"id":"auto","name":"Auto","description":"Claude handles permission decisions"},{"id":"bypassPermissions","name":"Bypass permissions","description":"Accepts all permissions"}]}}
```
```json
{"type":"focus.set","nodeId":"api"}
{"type":"prompt","turnId":"3f1c1c2e-8a7b-4a53-9a1a-5d1c0f0b7e11","nodeId":"api","text":"there might be a bug in how invoices are validated"}
```
```json
{"type":"agent.status","state":"busy","sessionId":"b446fcb7-2900-4ab8-aa24-a2f428210c32"}
{"type":"turn.started","turnId":"3f1c1c2e-8a7b-4a53-9a1a-5d1c0f0b7e11","nodeId":"api","text":"there might be a bug in how invoices are validated","contextPack":"[archmap context]\nnode: invoices-api (service) id=api\n…\n[/archmap context]"}
{"type":"stream","turnId":"3f1c1c2e-8a7b-4a53-9a1a-5d1c0f0b7e11","event":{"kind":"text","text":"Looking at the validation path in "}}
{"type":"stream","turnId":"3f1c1c2e-8a7b-4a53-9a1a-5d1c0f0b7e11","event":{"kind":"tool_call","toolCall":{"toolCallId":"toolu_01","title":"Read invoices.routes.ts","kind":"read","status":"in_progress","locations":[{"path":"services/invoices-api/src/routes/invoices/invoices.routes.ts"}]}}}
{"type":"stream","turnId":"3f1c1c2e-8a7b-4a53-9a1a-5d1c0f0b7e11","event":{"kind":"tool_result","toolCall":{"toolCallId":"toolu_01","title":"Read invoices.routes.ts","kind":"read","status":"completed","locations":[{"path":"services/invoices-api/src/routes/invoices/invoices.routes.ts"}],"output":"import { Router } from \"express\";\n…"}}}
{"type":"stream","turnId":"3f1c1c2e-8a7b-4a53-9a1a-5d1c0f0b7e11","event":{"kind":"tool_call","toolCall":{"toolCallId":"toolu_02","title":"Edit invoices.routes.ts","kind":"edit","status":"pending","locations":[{"path":"services/invoices-api/src/routes/invoices/invoices.routes.ts","line":12}]}}}
{"type":"permission.request","turnId":"3f1c1c2e-8a7b-4a53-9a1a-5d1c0f0b7e11","requestId":"perm_7","toolCall":{"toolCallId":"toolu_02","title":"Edit invoices.routes.ts","kind":"edit","status":"pending","locations":[{"path":"services/invoices-api/src/routes/invoices/invoices.routes.ts","line":12}]},"options":[{"optionId":"allow","name":"Allow","kind":"allow_once"},{"optionId":"allow_always","name":"Always allow edits in this session","kind":"allow_always"},{"optionId":"reject","name":"Reject","kind":"reject_once"}]}
```
```json
{"type":"permission.response","requestId":"perm_7","optionId":"allow"}
```
```json
{"type":"permission.resolved","turnId":"3f1c1c2e-8a7b-4a53-9a1a-5d1c0f0b7e11","requestId":"perm_7","optionId":"allow"}
{"type":"stream","turnId":"3f1c1c2e-8a7b-4a53-9a1a-5d1c0f0b7e11","event":{"kind":"diff","toolCallId":"toolu_02","path":"services/invoices-api/src/routes/invoices/invoices.routes.ts","oldText":"  currency: z.enum([\"EUR\", \"USD\"]),","newText":"  currency: z.enum([\"EUR\", \"USD\", \"GBP\"]),"}}
{"type":"stream","turnId":"3f1c1c2e-8a7b-4a53-9a1a-5d1c0f0b7e11","event":{"kind":"tool_result","toolCall":{"toolCallId":"toolu_02","title":"Edit invoices.routes.ts","kind":"edit","status":"completed","locations":[{"path":"services/invoices-api/src/routes/invoices/invoices.routes.ts","line":12}]}}}
{"type":"stream","turnId":"3f1c1c2e-8a7b-4a53-9a1a-5d1c0f0b7e11","event":{"kind":"text","text":"The enum rejected GBP invoices. I added it."}}
{"type":"turn.finished","turnId":"3f1c1c2e-8a7b-4a53-9a1a-5d1c0f0b7e11","stopReason":"end_turn"}
{"type":"agent.status","state":"idle","sessionId":"b446fcb7-2900-4ab8-aa24-a2f428210c32"}
```

The option ids above (`allow`, `allow_always`, `reject`) are illustrative. The daemon relays whatever the agent sends and never invents ids.

### 2.5 Mapping to ACP (daemon internals, for reference)

| WS | ACP |
| --- | --- |
| `prompt` | `session/prompt` with `prompt: ContentBlock[]` built per §3.3 |
| `stream.text` | `session/update` → `agent_message_chunk` with `content.type === "text"` |
| `stream.thought` | `agent_thought_chunk` |
| `stream.tool_call` / `tool_result` | `tool_call` / `tool_call_update`, merged by `toolCallId` |
| `stream.diff` | `ToolCallContent { type: "diff", path, oldText, newText }` |
| `stream.plan` | `plan` |
| `permission.request` | `session/request_permission { toolCall: ToolCallUpdate, options: PermissionOption[] }` |
| `permission.response` | `RequestPermissionResponse { outcome: { outcome: "selected", optionId } }` or `{ outcome: "cancelled" }` |
| `cancel` | `session/cancel` notification; prompt returns `stopReason: "cancelled"` |
| `mode.set` | `session/set_mode { sessionId, modeId }` |
| `model.set` | `session/set_config_option` on the agent's `model` option (fallback `session/set_model`); Claude SDK provider: `query.setModel()` |
| `agent.status.modes` | `NewSessionResponse.modes` and `current_mode_update`; agents without `modes` (OpenCode): the `select` config option with category `mode`, switched via `session/set_config_option` |
| `agent.status.models` | `NewSessionResponse.configOptions` (the `select` option with category `model`) and `config_option_update`; fallback: the unstable `NewSessionResponse.models` |
| ignored | `user_message_chunk`, `available_commands_update`, `config_option_update` (except the model option), `usage_update`, `session_info_update`, any `_`-prefixed extension method |

---

## 3. Context pack

The context pack is the text the daemon prepends to the user's prompt. It is built by `buildContextPack(architecture, nodeId)` in the daemon (`src/context/pack.ts`) and nowhere else. `GET /api/context/:nodeId` and `turn.started.contextPack` return exactly this string.

### 3.1 Template

Lines appear in this fixed order. A line is omitted entirely when its source field is absent or empty. `THIS` is the literal token for the selected node inside edge/workflow lines.

```
[archmap context]
node: {name} ({type}) id={id}
path: {path}
description: {description}
notes: {notes}
tech: {tech joined by ", "}
layer: {layer}
parent: {parent.name} ({parent.type}) path={parent.path}
children: {child.name} ({child.type}); {child.name} ({child.type}); …
files:
- {files[0]}
- {files[1]}
…
- +{n} more
incoming:
- {from.name} ({from.type}) path={from.path} -> THIS [{label}] [{kind}]
outgoing:
- THIS -> {to.name} ({to.type}) path={to.path} [{label}] [{kind}]
neighbors: {name}, {name}, …
workflows:
- {workflow.name}: step {i} of {n} ({prev.name} -> THIS -> {next.name})
[/archmap context]

The user selected the node above on an architecture diagram of the repository at {root}. Treat that node as the scope of the request. Open the listed path and files first; search elsewhere only if they do not answer the question. If you change files outside this node, say so explicitly.

{user text}
```

### 3.2 Rules (deterministic output)

1. Newlines inside `description`, `notes`, `label`, and `name` are replaced by a single space; runs of whitespace collapse to one space; leading/trailing whitespace trimmed.
2. `description` is truncated to 400 chars, `notes` to 600 chars. Truncation appends `…`.
3. `files`: first 12 entries in file order; if more, a final `- +{n} more` line.
4. `children`: direct children only, in file order, max 12, joined by `; `.
5. `incoming` / `outgoing`: edges in file order, max 12 each. `[{label}]` and `[{kind}]` are omitted when absent. `path={…}` is omitted when the other node has no path.
6. `neighbors`: unique names of nodes connected by any edge, in first-seen order over incoming then outgoing, max 12. Omitted when there are no edges.
7. `workflows`: every workflow whose `steps` contains the node, in file order. `i` is 1-based. `prev`/`next` are omitted at the ends: `(THIS -> {next.name})`, `({prev.name} -> THIS)`.
8. `{root}` is the absolute repo directory (the ACP session `cwd`).
9. Exactly one blank line between the closing tag and the instruction paragraph, one blank line between the instruction and the user text. No trailing newline after the user text.
10. Worst case size stays under ~1,200 tokens; typical nodes are under 300.

### 3.3 ACP prompt blocks

The daemon sends `session/prompt` with:

```json
[
  { "type": "resource_link", "uri": "file:///abs/repo/services/invoices-api/src/app.ts", "name": "services/invoices-api/src/app.ts" },
  { "type": "text", "text": "<the full string from §3.1>" }
]
```

Links come first and the text block last, because the text ends with the user's question and agents concatenate adjacent blocks: a link placed right after the question was read as part of it (2026-09-23).

One `resource_link` per listed file (same 12-file cap), only when the agent's `promptCapabilities` allow it (the Claude adapter treats them as `@`-mentions and opens the files without a tool round-trip). `--no-links` disables them. The text block is the contract; the links are an optimisation.

### 3.4 Example (node `api` from §1.4)

```
[archmap context]
node: invoices-api (service) id=api
path: services/invoices-api
description: Core business service. Handles invoice CRUD, validation and emits domain events.
notes: Validation lives in routes/, not in the service layer. Known flaky: currency enum.
tech: Node 22, Express, Zod
layer: services
children: routes (module); repositories (module)
files:
- services/invoices-api/src/app.ts
- services/invoices-api/src/routes/invoices/invoices.routes.ts
- services/invoices-api/src/routes/invoices/invoices.service.ts
- services/invoices-api/src/repositories/invoices.repo.ts
incoming:
- api-gateway (gateway) path=infra/gateway -> THIS [/v1/invoices] [sync]
outgoing:
- THIS -> postgres (datastore) [sql] [data]
- THIS -> events-bus (queue) [invoice.created] [event]
- THIS -> Stripe (external) [charge] [sync]
neighbors: api-gateway, postgres, events-bus, Stripe
workflows:
- Create invoice: step 3 of 7 (api-gateway -> THIS -> Validate)
[/archmap context]

The user selected the node above on an architecture diagram of the repository at /Users/petre/code/acme-platform. Treat that node as the scope of the request. Open the listed path and files first; search elsewhere only if they do not answer the question. If you change files outside this node, say so explicitly.

there might be a bug in how invoices are validated
```
