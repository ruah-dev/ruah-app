# CONTRACTS.md — ruah coupling contracts

These three contracts are the only coupling between the Lovable viewer ("Architect's Canvas") and the daemon (`ruah`). Both sides copy the TypeScript types verbatim and validate at the boundary with zod. Nothing else crosses the wire.

Written 2026-09-16 against ACP `protocolVersion: 1`, `@agentclientprotocol/sdk` 1.4.0, `@agentclientprotocol/claude-agent-acp` 0.78.0.

Conventions that apply to all three contracts:

- Paths are repo-relative, POSIX separators, no leading `./`, no trailing `/`. The only absolute path on the wire is `root` in the `architecture` message. ACP itself requires absolute paths; the daemon converts in both directions.
- IDs match `^[a-z0-9][a-z0-9._-]{0,63}$`. Node ids in a system architecture (§1.5) may carry one repo namespace: `^([a-z0-9][a-z0-9-]{0,62}:)?[a-z0-9][a-z0-9._-]{0,63}$` (e.g. `invoices-api:routes`).
- Timestamps are ISO 8601 UTC.
- Receivers ignore unknown fields and unknown `type`/`kind` values instead of rejecting the message.
- Strings are UTF-8, newlines are `\n`.

---

## 1. `architecture.json`

The file lives at `<repo>/architecture.json` (override with `ruah app serve --file`). The daemon reads, validates, watches, and serves it. The viewer never reads it from disk.

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
  repo?: string;        // system architectures only (§1.5): id of the owning repo in ruah.system.json
  x?: number;           // canvas units (px at zoom 1). Daemon fills both when missing; viewer never lays out.
  y?: number;
}

export interface ArchEdge {
  from: string;         // node id
  to: string;           // node id
  label?: string;       // <= 40 chars, rendered on the edge
  kind?: "sync" | "async" | "event" | "data" | (string & {}); // system scans also emit "deploy"
  source?: "scan" | "suggested" | "manual" | (string & {}); // provenance; absent = manual (§1.5)
  evidence?: string[];  // "path:line" locations backing the edge, e.g. "web/src/api.ts:12"
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
  generatedBy?: string; // e.g. "ruah app scan 0.1.0"
  generatedAt?: string;
  layers?: string[];    // drawn as labelled groups; order = drawing order
  nodes: ArchNode[];
  edges: ArchEdge[];
  workflows: Workflow[];
}
```

Extensions over the brief, each needed by the existing viewer or the scanner: `version`, `name`, `generatedBy`, `generatedAt`, the four extra `NodeType` values, `parent`, `x`, `y`, `Workflow.description`. Added 2026-09-23 for multi-repo systems (§1.5), all optional so existing files stay valid: `ArchNode.repo`, `ArchEdge.source`, `ArchEdge.evidence`.

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
  "generatedBy": "ruah app scan 0.1.0",
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

### 1.5 System architectures (multi-repo, 2026-09-23)

A system is defined by `ruah.system.json` (docs/MULTI-REPO.md): `{ "version": 1, "name": string, "repos": [{ "id": string, "path": string }] }`; repo ids match `^[a-z0-9][a-z0-9-]*$` (<= 63 chars) and are unique; paths are relative to the file. `ruah app system scan <dir>` writes the system's `architecture.json` next to it, in the same format as §1.1 with these conventions:

- **Top level**: one node per repo (`id` = repo id, `repo` = repo id, `path` = repo id, `type` inferred: `frontend | service | worker | library | infra | gateway`), plus shared infrastructure (`datastore | queue | gateway | external`, no `repo`), deduplicated across repos by kind (`postgres`, `kafka`, `stripe`, …).
- **Below a repo node**: that repo's own architecture, namespaced. Node ids `<repoId>:<nodeId>`, the repo's top-level nodes get `parent: <repoId>`, every node has `repo`. Workflow ids and steps are namespaced the same way.
- **Paths** (`path`, `files[]`, `evidence`) are system paths `<repoId>/<repo-relative path>`; the daemon resolves them through `ruah.system.json` (`resolveSystemPath` in `src/system/config.ts`), not against the system folder.
- **Edge provenance** (`source`): `scan` = produced by the system scanner (regenerated on every scan, replaced wholesale); `suggested` = an agent suggestion the user accepted; `manual` = drawn or written by a human. A missing `source` is treated as `manual` and written back as `manual`. Re-scans keep every non-`scan` edge whose ends still exist.
- **Evidence**: top-level `scan` edges carry `evidence` (<= 10 entries, sorted) naming the file:line that produced them (compose/k8s/terraform lines, env/config/source URLs, topic publish/consume calls, manifest dependency lines). `suggested` edges keep the evidence the agent gave.
- Receivers that edit and save an architecture MUST round-trip `repo`, `source` and `evidence` (unknown-field stripping turns scan edges into `manual` ones that re-scans can no longer replace).

### 1.6 On-demand drill-in (ephemeral levels, 2026-09-23)

`architecture.json` usually stops at packages / modules. Every element with a `path` and no stored children can be expanded one level at a time by `GET /api/expand/:nodeId` (§2.3). The result is **derived data**: computed from the working tree, cached in memory (file list ~4 s, per-file parses by mtime), never written to `architecture.json`.

Levels: stored node (directory path) → **folder** level: sub-folders (`type: "module"`, single-child chains compacted into one node named `a/b/c`) and files (`type: "file"`: source, tests, and a few text formats — json/yaml/md/css/sql/…; lockfiles and binaries skipped), with `imports` edges between them (a folder counts every file below it); **file** level: `type: "symbol"` children (functions, React components and hooks, classes, interfaces/types/enums, exported values, route handlers such as `GET /users`) with `calls` / `uses` / `renders` edges between symbols of the same file. Symbols have no children. Parsing is regex-based (TS/JS full, Python/Go/Rust basic), no new dependencies.

```ts
export interface ExpandedNode extends ArchNode {  // parent = the expanded element's id
  expandable?: boolean;   // can be expanded again (folder, or a file with symbols)
  childCount?: number;    // direct children one level further down
  symbol?: { kind: "function" | "component" | "hook" | "class" | "type" | "interface" | "enum" | "const" | "route" | "method";
             line: number; endLine: number; exported: boolean; detail?: string };  // 1-based, inclusive
  test?: boolean;
}
export interface Expansion {
  nodeId: string;                    // the element that was expanded
  level: "folder" | "file";
  path: string;                      // its path (system path in a multi-repo system)
  architecture: Architecture;        // §1.1 schema: nodes are ExpandedNode[], edges carry source "scan" (+ weight = import count)
  truncated: { children: boolean; edges: boolean; files: boolean }; // caps: 80 children, 200 edges, 1,500 files read per level
  total: { children: number; edges: number };
  ms: number;
  lineage?: string[];                // expanded elements above nodeId, outermost first (rebuilds the breadcrumb after a reload)
}
```

- **Ids** are namespaced under the expanded element: `<id>/<entry name>` for folders and files (`web/src/components/Button.tsx`, compacted `web/src/main/java`), `<fileId>#<symbol key>` for symbols (`…/Button.tsx#Button`; the key is the name, `name~2` for duplicates). They never match the §1 id pattern, so they cannot collide with stored ids, and any of them resolves again from a cold cache by expanding its ancestors.
- **Paths** are architecture paths (repo-relative, or `<repoId>/<path>` in systems, resolved through the store's `resolvePath`).
- **Layers** of an expansion: `folders`, `files`, `tests`, `other` (folder level); `routes`, `components`, `hooks`, `functions`, `classes`, `types`, `values` (file level). Positions come from the scanner's grid (260 × 110), importers first inside a band.
- **Prompts and context** accept expanded ids: `prompt.nodeId` and `GET /api/context/:nodeId` resolve them through the expander. The pack then shows the element with its parent, its siblings' edges and its file; a symbol's description carries its line range (`Exported component Header, lines 19–23 of src/App.tsx.`). Unknown ids still answer `unknown_node` / 404.
- **Pin to map** (viewer): copies an expanded folder level into `architecture.json` through the ordinary `architecture.save` (stored ids, `source: "scan"` edges); after that the level is stored and no longer expanded.

### 1.7 Map edits by coding agents (the `ruah_*` tools, 2026-09-23)

Agents read and edit the **open project's** architecture while they work ("draw the architecture for feature X", "add the payments service and connect it to postgres"). Every change goes through the daemon's store — validated (§1.2), written atomically, broadcast — so the viewer updates live.

**Provenance (additive, optional):**

```ts
interface ArchNode { /* … */ origin?: "scan" | "user" | "agent" | (string & {}) } // absent = scanned or hand-written
interface ArchEdge { /* … */ source?: "scan" | "suggested" | "manual" | "agent" | (string & {}) }
```

- The tools write `origin: "agent"` on new elements and `source: "agent"` on new links. Re-scans (repo and system merges) keep `agent` / `manual` / `suggested` links whose ends exist, keep elements with `origin` `agent` or `user` even when their `path` does not exist (yet), and keep an existing non-`scan` `origin` on an element the scan also produces.
- The viewer marks `origin: "agent"` elements with a lavender dot until the user presses **Keep** or edits the element (not just moves it): it then becomes `origin: "user"` and its agent links `source: "manual"`.

**Tools** (MCP server `ruah`; names as the model sees them: `ruah_…`, in Claude `mcp__ruah__ruah_…`). Elements are referenced by id or by their exact (case-insensitive) name when unique.

| Tool | Arguments | Effect |
| --- | --- | --- |
| `ruah_get_architecture` | `level?` (element id; `""` = top level; absent = all) | text summary: elements `id · name · type · layer · parent · path` (+ "N inside", "agent-made"), links, workflows |
| `ruah_get_element` | `id` | JSON: all fields, parent, children, incoming / outgoing links, workflows |
| `ruah_find_elements` | `query`, `type?`, `limit?` | elements matching every word (id, name, path, tech, description, files) |
| `ruah_add_element` | `name`, `type`, `id?`, `layer?`, `parent?`, `path?`, `tech?`, `description?` (≤ 400), `notes?`, `files?` (≤ 20) | id defaults to a slug of the name (namespaced `<repo>:` under a system repo parent, which also sets `repo`); a new layer is appended to `layers`; placed next to the first element it links to on its level, else below the level |
| `ruah_update_element` | `id`, patch fields (`null` clears; `parent: null` = top level) | the id never changes |
| `ruah_remove_element` | `id`, `recursive?` | removes its links and workflow steps (workflows left with < 2 steps go); refused when it has children unless `recursive` |
| `ruah_connect` / `ruah_disconnect` | `from`, `to`, `label?` (≤ 40), `kind?` | connect is idempotent (same from/to/label: updates `kind`); disconnect without `label` removes every from→to link |
| `ruah_add_workflow` / `ruah_update_workflow` | `name`, `steps` (≥ 2), `id?`, `description?` | |
| `ruah_apply` | `ops: ArchOp[]` (≤ 200) | several of the above, all or nothing: one save, one broadcast |

```ts
type ArchOp =
  | { op: "add_element"; id?; name; type; layer?; parent?; path?; tech?; description?; notes?; files?; x?; y? }
  | { op: "update_element"; id; patch: { name?; type?; layer?|null; parent?|null; path?|null; tech?|null; description?|null; notes?|null; files?|null; x?; y? } }
  | { op: "remove_element"; id; recursive? }
  | { op: "connect"; from; to; label?; kind? } | { op: "disconnect"; from; to; label? }
  | { op: "add_workflow"; id?; name; description?; steps } | { op: "update_workflow"; id; name?; description?|null; steps? }
  | { op: "remove_workflow"; id } | { op: "set_layout_hint"; id; x; y };
```

A failing op or a result that fails §1.2 aborts the whole call; the tool answers `isError: true` with a message meant for the agent (`op 2 of 3 (connect): unknown to element "Nope" — did you mean …; nothing was changed`). Warnings about the changed elements (e.g. a `path` that does not exist yet) are appended to a successful result.

**Transports.**
- Claude Agent SDK: in-process (`createSdkMcpServer`), allowed without a permission prompt; the system prompt gets the tools hint appended.
- ACP agents: `session/new` and `session/load` carry `mcpServers: [{ name: "ruah", command: <node>, args: [<cli>, "mcp", "--daemon", "http://127.0.0.1:<port>"], env: [{ name: "RUAH_MCP_TOKEN", value: <token> }] }]`. `ruah app mcp --daemon <url> [--token <t>]` is a stdio MCP server (JSON-RPC 2.0, protocol `2025-06-18`, also `2025-03-26` / `2024-11-05`) with the same tools. The bridge answers the agent's permission requests for `ruah_*` tools with allow-once.
- Both add one sentence to the context pack's instruction paragraph (§3.1): `You can read and edit this project's architecture map with the ruah_* tools; keep it in sync when you add or change services, modules, datastores or links.` (not for the mock agent; `RUAH_MAP_TOOLS=0` turns the tools off).

**HTTP (local IPC for `ruah app mcp`, not for browsers).**

| Method + path | Body / result |
| --- | --- |
| `GET /api/arch` | `{ revision, architecture }` of the open project |
| `POST /api/arch/ops` | `{ ops: ArchOp[] }` (1–200) → `{ ok: true, revision, results: { op, id?, message }[], changes: MapChange[], warnings: string[] }` |

Both require: a loopback peer (else 403), **no** `Origin` header (403), and the per-bridge capability token in `x-ruah-token` or `Authorization: Bearer` (missing / unknown → 401). A token belongs to one *(agent, project root)*: when another project is open → 409. Bad body → 400; op or validation failure → 422 `{ error }`; body > 1 MiB → 413.

**Broadcast and chat (additive to §2 / §5).**

```ts
interface MapActor { kind: "agent" | "user" | "scan" | (string & {}); agentId?: string; turnId?: string; undo?: boolean }
interface MapChange {
  action: "add" | "update" | "remove" | "connect" | "disconnect" | "move" | "add_workflow" | "update_workflow" | "remove_workflow" | (string & {});
  target: "element" | "link" | "workflow" | (string & {});
  id: string;            // element id, workflow id, or "<from>-><to>"
  name: string;          // display text ("Stripe", "data → Stripe", workflow name)
  level?: string | null; // parent of the element (links: of `from`); null = top level
  fields?: string[]; from?: string; to?: string; label?: string;
}
// daemon → viewer, architecture{reason:"saved"} gains:
//   by?: MapActor           agent op: { kind:"agent", agentId, turnId? }; viewer save: { kind:"user" };
//                           rescan: { kind:"scan" }; undo: { kind:"user", turnId, undo:true }
//   changes?: MapChange[]   agent ops and undos
// TurnRecord (§5.1) gains mapChanges?: MapChange[]   (the turn's agent ops, in order)
// viewer → daemon: { type: "arch.undo", turnId }
```

`arch.undo` restores what that turn's ops changed, from a snapshot the daemon took before the turn's first op (memory only, last 30 turns): every element, link and workflow that differs between before and after the turn goes back to its before state, unless it changed again since (the later edit wins); links and steps left dangling are dropped. The result is broadcast as `architecture{by:{kind:"user", turnId, undo:true}, changes}`. Nothing to undo (restart, already undone, everything changed since) → `error{bad_message, "undo failed: …"}`.

The store no longer re-broadcasts its own write when the file watcher sees it: one save is one revision.

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
  | { type: "prompt"; turnId: string; nodeId?: string; text: string;
      attachments?: { id: string; name: string }[] }                      // turnId: viewer-generated UUID; attachments: ≤ 8 uploaded images (§5.6)
                                                                           // nodeId omitted = plain chat on the project: the text goes to the agent as typed, contextPack ""
  | { type: "permission.response"; requestId: string; optionId: string }  // optionId must be one of the offered options
  | { type: "permission.response"; requestId: string; cancelled: true }   // user dismissed
  | { type: "cancel"; turnId: string }
  | { type: "session.reset" }                                             // Phase 3: new ACP session (drops agent memory)
  | { type: "mode.set"; modeId: string }                                  // Phase 3: session/set_mode; saved as that agent's default mode (§5.7)
  | { type: "model.set"; modelId: string }                                // switch model for the live session; saved as that agent's default model (§5.7)
  | { type: "agent.set"; agentId: string }                                // switch coding agent (cancelling any turn): a pre-warmed one is swapped in at once, else started; saved as the default agent
  | { type: "agent.prewarm"; agentIds?: string[] }                        // start these agents in the background (default: every installed agent but the current one) (§5.7)
  | { type: "defaults.set"; agentId?: string;                             // Settings → Agents: saved defaults (§5.7); null clears an entry
      models?: Record<string, string | null>; modes?: Record<string, string | null> }
  | { type: "architecture.save"; architecture: Architecture };            // Phase 3: daemon validates + writes the file

// ---------- daemon -> viewer ----------
export type ServerMessage =
  | { type: "architecture"; reason: "initial" | "changed" | "saved"; revision: number;
      root: string; path: string; architecture: Architecture }            // root = absolute repo dir on the daemon host
  | { type: "architecture.error"; path: string; message: string }         // file invalid; previous revision stays live
  | { type: "agent.status"; state: AgentState; agent?: { name: string; version: string };
      sessionId?: string; modes?: ModeState; models?: ModelState; agents?: AgentChoiceState; error?: string;
      defaults?: { agentId: string; models: Record<string, string>; modes: Record<string, string> } } // §5.7
  | { type: "turn.started"; turnId: string; nodeId?: string; contextPack: string; text: string;
      attachments?: { id: string; name: string; mimeType: string }[]    // the prompt's images (§5.6), absent when none
      queued?: true }                                                    // the agent is still starting; a second turn.started (without it) follows when the prompt is sent
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
  available: { id: string; name: string; installed: boolean; description?: string; installHint?: string;
               images?: boolean;                                  // takes images in prompts (§5.6); absent = not known yet
               warm?: "ready" | "starting" | "cold";              // installed agents, open project: pre-warm state (§5.7)
               warmError?: string;                                // why the last pre-warm failed (the agent stays cold)
               models?: ModelState; modes?: ModeState }[];        // last reported by that agent (non-current agents)
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
3. `prompt` is accepted when `agent.status.state === "idle"` (or `"error"`: the agent is restarted). Accepted prompts produce `turn.started` (carrying the exact context pack that was sent, for transparency) and then `stream` events until `turn.finished`. **While the current agent is `starting`** (e.g. right after `agent.set` to a cold agent, or while it applies its saved model / mode) the prompt is **queued** instead of refused: `turn.started{queued:true}` at once (the viewer shows the user bubble with "waiting for <agent>…"), then — once the agent is idle — the prompt is sent and a second `turn.started` (without `queued`) follows. One prompt can wait at a time (another one → `error{busy, turnId}`). `cancel` of a queued turn ends it with `turn.finished{cancelled}` without it ever reaching the agent; a switch (agent, project, chat) does the same. If the agent fails to start, the queued turn ends `turn.finished{error, error:"<agent> did not start: <reason>"}`. A queued or cancelled turn is stored in its chat like any other. Otherwise (`busy`, `stopped`) → `error{busy, turnId}`.
4. `permission.request` blocks the agent until `permission.response` arrives. There is no daemon-side timeout in Phase 1. `permission.resolved` is echoed so a second viewer tab stays consistent.
5. `cancel` makes the daemon (a) answer every pending `permission.request` of that turn with ACP `{outcome:"cancelled"}`, (b) send ACP `session/cancel`, (c) wait up to 15 s for the ACP prompt response, then `turn.finished{stopReason:"cancelled"}`. If the agent does not respond in 15 s the daemon kills and respawns it and sends `turn.finished{stopReason:"error"}` + `agent.status`.
6. A running turn is cancelled only when the **last** viewer disconnects and none reconnects within 5 s (`RUAH_DISCONNECT_GRACE_MS`); another open tab or a page reload keeps it running. (Later: buffer the turn's events and replay them on reconnect.)
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
| `GET /api/expand/:nodeId` | `Expansion` (§1.6): the level below a stored or expanded element | `nodeId` URL-encoded; 404 unknown element or path, 422 not expandable (no path, a symbol, a file without an outline); Origin checked like `/ws` (403) |
| `GET /api/expand-peek?id=<id>&id=<id>…` | `{ counts: { [id]: number \| null } }` direct child counts for "N inside" chips, without expanding (null = not expandable) | max 200 ids; Origin checked (403) |
| `POST /api/rescan` | re-run the scanner on the served repo, merging hand edits; `{ ok, nodes, edges, layers, ms }` | Origin checked like `/ws` (403 otherwise); result is broadcast as `architecture` reason `saved`; 422 if the result fails validation |
| `POST /api/attachments?name=<file name>` | raw image body → `{ id, name, mimeType, size, width?, height? }` | §5.6; Origin checked (403); 409 without a project; 413 over 10 MB; 415 not an image |
| `GET /api/attachments/:id` | the stored image | §5.6; `id` must match `^[a-f0-9]{64}\.(png\|jpg\|gif\|webp)$` (400 otherwise), 404 unknown |
| `GET /api/export/drawio` | the open project as an uncompressed draw.io file (`<mxfile>`): page "Overview" (top level, title block, legend), one page per element with children (named by breadcrumb, e.g. `api / routes`), one page "Workflow: <name>" per workflow, page "Specifications" (tables of every element, link and workflow) | `Content-Type: application/vnd.jgraph.mxfile; charset=utf-8`, `Content-Disposition: attachment; filename="<name>.drawio"`; 409 without a project. Elements and links are UserObjects whose properties carry the specs (`ruahId, type, layer, parent, repo, path, tech, files, description, notes, links, cloud, issues`; links: `from, to, kind, source, evidence`); drillable elements `link` to their page (`data:page/id,<pageId>`). Linked cloud resources and issues (§6) are included read-only when the integrations answer within 8 s, otherwise the export notes it on the Specifications page. Deterministic. CLI: `ruah app export drawio <repo> [--out <file>]` (local files only: `.ruah/links.json`, cached `cloud.json`) |
| `GET /api/usage/summary?range=24h\|7d\|30d` | `{ range, totals: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd: number\|null, turns }, series: { t, agentId, model, inputTokens, outputTokens, costUsd\|null }[], byModel: { agentId, model, turns, inputTokens, outputTokens, costUsd\|null }[] }` | per-turn usage recorded by the daemon in `~/.ruah/usage.jsonl` (all repos); `t` = ISO bucket start (hourly for 24h, daily otherwise); `costUsd` only when the agent reports it |
| `GET /api/arch`, `POST /api/arch/ops` | map ops for `ruah app mcp` (§1.7) | loopback + capability token only; no Origin allowed |
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
{"type":"turn.started","turnId":"3f1c1c2e-8a7b-4a53-9a1a-5d1c0f0b7e11","nodeId":"api","text":"there might be a bug in how invoices are validated","contextPack":"[ruah context]\nnode: invoices-api (service) id=api\n…\n[/ruah context]"}
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
[ruah context]
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
[/ruah context]

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

With image attachments (§5.6) the prompt starts with one ACP `image` block per image (`{ type: "image", mimeType, data: <base64> }`, in the order attached), before the links and the text, for the same reason: the question stays last.

One `resource_link` per listed file (same 12-file cap), only when the agent's `promptCapabilities` allow it (the Claude adapter treats them as `@`-mentions and opens the files without a tool round-trip). `--no-links` disables them. The text block is the contract; the links are an optimisation.

### 3.4 Example (node `api` from §1.4)

```
[ruah context]
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
[/ruah context]

The user selected the node above on an architecture diagram of the repository at /Users/petre/code/acme-platform. Treat that node as the scope of the request. Open the listed path and files first; search elsewhere only if they do not answer the question. If you change files outside this node, say so explicitly.

there might be a bug in how invoices are validated
```

## 5. Projects, launcher and chats (2026-09-23)

The daemon can start **without a repo** (launcher state) and switch projects at
runtime, so the app opens on a start screen and project switching needs no
restart. All state-changing HTTP calls below are **POST with the same Origin
check as `/ws`** (403 otherwise).

### 5.1 Types
```ts
export interface ProjectInfo {
  id: string;                    // stable: sha1(realpath(root)).slice(0, 12)
  name: string;                  // architecture name, else folder name
  root: string;                  // absolute path (repo dir, or the folder holding ruah.system.json)
  kind: "repo" | "system";       // "system" = multi-repo (docs/MULTI-REPO.md)
  lastOpenedAt: string;          // ISO
  pinned?: boolean;
}
export interface ChatInfo {
  id: string;                    // uuid
  projectId: string;
  title: string;                 // first prompt, trimmed to 80 chars, renameable
  agentId: string;               // agent used when the chat was created
  model?: string;
  createdAt: string; updatedAt: string;
  turnCount: number;
  lastNodeId?: string;
}
export interface TurnRecord {    // what the viewer needs to redraw a past turn
  turnId: string; nodeId?: string; text: string; contextPack: string;   // nodeId absent = asked without context
  attachments?: { id: string; name: string; mimeType: string }[];   // the prompt's images (§5.6)
  events: StreamEvent[]; stopReason?: StopReason; startedAt: string; finishedAt?: string;
}
```

### 5.2 WebSocket additions
- daemon → viewer `{ type: "project", project: ProjectInfo | null }` — sent after `hello` and on every switch. `null` = launcher state (no `architecture` message follows).
- daemon → viewer `{ type: "chats", projectId, chats: ChatInfo[], activeChatId: string | null }` — after `hello`, on switch, and whenever the list changes.
- daemon → viewer `{ type: "chat.history", chatId, turns: TurnRecord[] }` — reply to `chat.open` (and after `hello` for the active chat).
- viewer → daemon `{ type: "chat.new" }`, `{ type: "chat.open", chatId }`, `{ type: "chat.rename", chatId, title }`, `{ type: "chat.delete", chatId }`.
- Turns (`prompt`) always belong to the active chat; `chat.new` / `chat.open` cancel a running turn first.

### 5.3 HTTP additions
| Method + path | Body / result |
| --- | --- |
| `GET /api/projects` | `{ current: ProjectInfo \| null, recent: ProjectInfo[] }` (most recent first, pinned on top) |
| `POST /api/projects/open` | `{ path, chatId? }` → `ProjectInfo`. With `chatId` the project opens on that chat (one `chats` frame with that `activeChatId`, then its `chat.history`; unknown ids are ignored; on the already-open project it acts like `chat.open`). Scans first when there is no `architecture.json`; opens as `system` when `ruah.system.json` exists. Broadcasts `project`, `architecture`, `chats`. |
| `POST /api/projects/create` | `{ parentDir, name, git?: boolean }` → `ProjectInfo`. Creates the folder (must not exist), optional `git init`, an empty `architecture.json` (valid, zero nodes), then opens it. |
| `POST /api/projects/pin` / `forget` | `{ id, pinned? }` → `{ ok: true }` (forget only removes it from the recent list) |
| `GET /api/chats/recent?limit=50` | `{ chats: (ChatInfo & { projectName: string; projectRoot: string })[] }` across all projects, newest first |
| `GET /api/chats/recent?projectId=<id>&limit=5` | same shape, only that project's chats (sidebar "Projects" section, lazy per project) |
| `GET /api/chats/history?projectId=&chatId=` | `{ projectId, chatId, turns: TurnRecord[] }` of any stored chat (hover prefetch, so opening it paints at once); 404 unknown |
| `GET /api/projects/preview?id=<projectId>` | `{ project, architecture: Architecture \| null, chats: ChatInfo[], activeChatId, activeTurns: TurnRecord[] }` — what the viewer needs to paint a project before the switch completes (architecture read from disk for repos; the live one for the open project; `null` for systems that are not open) |

Storage: `~/.ruah/projects.json` (recent list) and
`~/.ruah/projects/<projectId>/chats/<chatId>.jsonl` (one `TurnRecord` per
line, plus a header line with `ChatInfo`). `RUAH_HOME` overrides `~/.ruah`.
Agent sessions resume with the chat: Claude SDK `resume: sessionId`; ACP
`session/load` when the agent advertises `loadSession`, otherwise a new
session (the viewer still shows the stored history).

### 5.4 Desktop bridge (Electron preload)
`window.ruah = { version, pickFolder(opts?: { title?: string }): Promise<string | null>, revealInFinder(path): void }`
(IPC to the main process; `dialog.showOpenDialog`). In a plain browser
`window.ruah` is absent and the viewer offers a path text field instead.

### 5.5 Behaviour details (daemon, 2026-09-23)
- After `hello`: `project`, then (with a project) `architecture` and `agent.status`, then `chats` and the active chat's `chat.history`. Launcher state: `project{null}` + `agent.status{state:"stopped"}` only.
- On a switch: a running turn is announced `turn.finished{cancelled}` (and stored; the old project's `chats` follows) first, then `project`, `architecture` (or `architecture.error` if the file is invalid), `chats`, `chat.history` (when a chat is active), `agent.status` (`starting` → `idle`, or `idle` at once for a warm agent).
- Launcher state: `/api/architecture`, `/api/context/*`, `/api/file`, `/api/rescan` answer `409 { error: "no project open" }`; WS `prompt`/`chat.*`/`mode.set`/`model.set`/`session.reset` answer `error{bad_message, "no project open"}`; `agent.set` only changes the agent used for the next project.
- The active chat on open is the one last active in that project — persisted in `~/.ruah/projects/<id>/state.json` (`{ version: 1, activeChatId: string | null }`, written on every chat switch, so it survives daemon restarts; a chat id that no longer exists is ignored) — else the most recently updated chat, else none (`activeChatId: null`). A `prompt` without an active chat creates one titled after the prompt. `chat.new` reuses the active chat when it has no turns (its title is "New chat" until the first prompt).
- `open` of the project that is already open only refreshes `lastOpenedAt`. Paths may start with `~/`. Errors: 400 bad body/not a folder/bad name, 404 path or parent missing, 409 create target exists, 422 invalid `ruah.system.json`, 403 Origin.
- The chat header line may carry daemon-internal fields (`sessions`: agent session id per agent id, `autoTitle`); they are never sent on the wire.

### 5.6 Image attachments (2026-09-23)

Screenshots and mockups travel **over HTTP, not the WebSocket** (frames stay ≤ 1 MiB, §2.2 rule 11): the viewer uploads each image, then references it from `prompt`.

1. **Upload** `POST /api/attachments?name=<file name>` with the raw bytes as the body and `Content-Type: image/png | image/jpeg | image/gif | image/webp` (anything else → 415). Same Origin check as every state-changing POST (403). Needs an open project (409 `no project open`). At most 10 MB (413). The daemon **sniffs the magic bytes** and stores the image under the type it actually is (a "PNG" that is really a JPEG is stored as `.jpg`; bytes that are no PNG/JPEG/GIF/WebP → 415). Answer:
   ```ts
   { id: string;            // "<sha256 of the bytes>.<png|jpg|gif|webp>" — same bytes, same id (dedupe)
     name: string;          // ?name, last path segment, control chars removed, ≤ 120 chars; default "image.<ext>"
     mimeType: string; size: number; width?: number; height?: number }  // pixel size from the header when readable
   ```
   Storage: `~/.ruah/projects/<projectId>/attachments/<id>` (`RUAH_HOME` honoured), written atomically.
2. **Serve** `GET /api/attachments/:id` returns the image of the open project with its `Content-Type`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: same-site` and an immutable cache header (ids are content hashes). Ids are validated against `^[a-f0-9]{64}\.(png|jpg|gif|webp)$` before any path is built (400 otherwise; no traversal); unknown → 404.
3. **Prompt** `{ type: "prompt", …, attachments: [{ id, name }] }` (≤ 8, validated by the frame schema). The daemon reads each file and puts one ACP `image` block per image **before** the text (§3.3). Rejections (`error{bad_message, turnId}`, no turn starts): the current agent cannot read images — `"<agent> can't read images — switch to Claude Code or remove the image"` — or a referenced file is missing (`attachment not found: <name> — attach it again`).
4. **Which agents take images:** the Claude Agent SDK always (PNG, JPEG, GIF, WebP); ACP agents when `initialize` answered `agentCapabilities.promptCapabilities.image: true`. `agent.status.agents.available[].images` carries it (absent until an ACP agent has been initialized once); unknown counts as "no" for a prompt. The viewer disables attaching while the current agent's `images` is not `true`.
5. **History:** `turn.started` and the stored `TurnRecord` carry `attachments: { id, name, mimeType }[]`, so `chat.history` redraws the thumbnails (`GET /api/attachments/:id`). Images are **not deleted with a chat** (they are content-addressed and may be shared between chats); remove `~/.ruah/projects/<id>/attachments/` by hand to reclaim space.

### 5.7 Instant agent switching and saved defaults (2026-09-23)

**Pre-warming.** `agent.prewarm { agentIds? }` starts agents in the background
for the open project without changing the current agent: default = every
installed agent except the current one (agents this project's chats used first).
They start one at a time, after the current agent is up (lowest priority), and
stay in the warm pool. The viewer sends it when the Agent · Model picker opens
(all) and when the pointer rests on an agent row (that one). The daemon also
pre-warms by itself: 3 s after a project opened and its agent is idle, the (at
most 2) agents this project used before. `agents.available[].warm` reports
`"ready"` (idle: `agent.set` makes it current in the same tick — measured < 1 ms
server-side), `"starting"` (`agent.set` attaches to that start; no second
process) or `"cold"`; `agent.status` is re-sent whenever a warm state changes. A
pre-warm that fails (e.g. Kiro not logged in) is stopped, reported as `cold` with
`warmError`, never as the current agent's `error`, and not retried for 5 min
(an explicit `agent.set` always tries). Off with `RUAH_PREWARM=0`, with
`--mock`, and when `RUAH_WARM_TTL_MS=0`.

**Pool.** At most 4 live agent processes (`RUAH_MAX_LIVE_AGENTS`), each warm one
kept 15 min after its last use (`RUAH_WARM_TTL_MS`); the least recently used
warm one is evicted first and the current agent never. A pre-warm never evicts
another warm agent of the same project (only one of another project); an
`agent.set` evicts whatever is least recently used.

**Saved defaults.** `$RUAH_HOME/settings.json` (`~/.ruah`, atomic writes):
`{ version: 1, defaultAgentId?, models: { [agentId]: modelId }, modes: { [agentId]: modeId } }`
(unknown keys are kept). `agent.set` saves the default agent, `model.set` /
`mode.set` (once the agent accepted them) the current agent's default model /
mode; `defaults.set` (Settings → Agents) writes them directly (an unknown or
uninstalled `agentId` → `error`) and applies the new model / mode to that
agent's idle live processes in the open project. `serve` without `--agent`
starts the saved default agent when installed, else Claude Code. `agent.status.defaults`
carries `{ agentId, models, modes }` — the saved values, with `modes` filled in
by the built-in default modes below.

Which model / mode a **new agent session** gets (new process, reset, resumed
chat), applied once per session before a prompt is sent (prompts wait):
1. the choice made in this project during this daemon's life (`model.set` /
   `mode.set`; cleared for an agent by `defaults.set`),
2. else the saved default for the agent,
3. else (mode only) the built-in default: the agent's "edit files without
   asking" mode — Claude Code / claude-acp `acceptEdits`, Cursor `agent`, OpenCode
   `build`, Kiro / others a mode that reads as "accept edits" / "auto edit" and not
   as bypass / trust-all, Grok none (its default stays). Shell commands and other
   tools still ask. Never `bypassPermissions`, `--trust-all-tools` or `--force`.
A choice the agent does not offer is skipped. Later mode changes the agent makes
itself (leaving plan mode) are not reverted.

## 6. Integrations (2026-09-23)

One framework, three families: **cloud** (see deployed services), **work
items** (issues linked to elements), **ruah orchestration** (tasks and
workflows from the `ruah` CLI). Credentials are **never** stored by Ruah in
plain files: cloud uses the provider CLI's own login (`doctl auth`, AWS
profiles / SSO); tokens that must be stored (Jira) go to the macOS Keychain
(service `ruah`, account `<integrationId>:<site>`). Everything is read-only
unless an action below says otherwise.

### 6.1 Types
```ts
export interface IntegrationInfo {
  id: "digitalocean" | "aws" | "jira" | "github" | "ruah" | (string & {});
  family: "cloud" | "work" | "orchestration";
  name: string;
  status: "connected" | "not_connected" | "cli_missing" | "error";
  detail?: string;               // e.g. "doctl context: default", "AWS CLI not installed"
  setupHint?: string;            // what the user runs / enters to connect
  accounts?: { id: string; label: string }[];   // aws profiles, doctl contexts, jira sites
}
export interface CloudResource {
  id: string;                    // provider-native id (ARN, DO URN)
  provider: "digitalocean" | "aws" | (string & {});
  type: "compute" | "container" | "function" | "app" | "database" | "cache" | "queue"
      | "storage" | "loadbalancer" | "gateway" | "cdn" | "dns" | "kubernetes" | "other";
  service: string;               // "droplet", "apps", "ec2", "lambda", "rds", …
  name: string; region?: string; status?: string;
  tags?: Record<string, string>;
  consoleUrl?: string;
  linkedNodeId?: string;         // architecture element it runs (tag ruah:node, name match, or manual)
  linkSource?: "tag" | "name" | "manual"; // how linkedNodeId was decided (viewer shows auto vs manual)
}
export interface WorkItem {
  id: string;                    // "PLAT-123", "owner/repo#42"
  provider: "jira" | "github" | (string & {});
  title: string; status: string; url: string;
  assignee?: string; updatedAt: string;
  linkedNodeIds: string[];       // stored links (elements ↔ issues)
}
```

### 6.2 HTTP
| Method + path | Result |
| --- | --- |
| `GET /api/integrations` | `{ integrations: IntegrationInfo[] }` |
| `POST /api/integrations/:id/connect` | body per provider (Jira: `{ site, email, token }` → Keychain; others: `{ account? }` to pick profile/context) → `IntegrationInfo` |
| `POST /api/integrations/:id/disconnect` | removes stored token/selection → `IntegrationInfo` |
| `POST /api/cloud/sync` | `{ providers?: string[], accounts?: Record<string,string> }` → `{ resources: CloudResource[], syncedAt, errors: { provider, message }[] }`; cached per project in `~/.ruah/projects/<id>/cloud.json` |
| `GET /api/cloud/resources` | last sync result (same shape) |
| `POST /api/cloud/link` | `{ resourceId, nodeId \| null }` → `{ ok }` (manual link, persisted) |
| `GET /api/work/items?nodeId=&q=` | `{ items: WorkItem[] }` (linked to the node, or search) |
| `POST /api/work/link` | `{ provider, itemId, nodeId, linked: boolean }` → `{ ok }` |
| `POST /api/work/create` | `{ provider, projectKey \| repo, title, body, nodeId }` → `WorkItem` (creates the issue — the viewer must confirm first) |
| `GET /api/ruah/status` | `ruah status --json` passthrough, or `{ initialized: false, hint }` |
| `POST /api/ruah/task` | `{ name, prompt, files?: string[], executor?: string, nodeId? , start?: boolean }` → task JSON (runs `ruah task create` [+ `start`]) |
| `POST /api/ruah/task/:name/:action` | action ∈ `start \| done \| merge \| cancel` |
| `GET /api/ruah/workflows` / `POST /api/ruah/workflows/:name/run` | list / run |

Links between work items and elements are stored in the project
(`.ruah/links.json` inside the repo, committable) so a team shares them.

---

## 7. Integrated terminal (2026-09-23)

A bottom panel in the viewer runs the user's login shell in PTYs owned by the
daemon (`src/terminal/*`, types in `src/contracts/terminal.ts`, viewer
`ui/src/lib/terminal.ts`). A terminal is arbitrary code execution as the user,
so its transport is separate from `/ws` and needs a capability token.

### 7.1 Access
| Step | Rule |
| --- | --- |
| `GET /api/terminal/token` → `{ token }` | Loopback peer; `Host` is `localhost` / `127.0.0.1` / `[::1]` (DNS-rebinding defence); `Sec-Fetch-Site`, when sent, is `same-origin` or `none`; `Origin`, when sent, equals the `Host`'s origin and passes the `/ws` rule (§2.2 rule 10). No CORS headers, `cache-control: no-store`. 403 otherwise. The token is 32 random bytes per daemon run. |
| `GET /ws/terminal?token=…` (upgrade) | Same peer + `Host` rules, the `/ws` Origin rule, and the token (constant-time compare): 401 without / with a wrong token, 403 for a refused peer, host or origin. |
| `--host <non-loopback>` | Terminals are off (token 403, socket 403) unless `--allow-remote-terminal`; then remote peers are allowed but `Host` must still be an IP literal, `localhost` or the `--host` value. |
| node-pty cannot load | The daemon keeps running; `ready.available = false` with the fix in `reason` ("Terminal unavailable: … run `pnpm rebuild node-pty` …"), `create` answers `error`. |

A viewer served from another origin (`?daemon=`, the Lovable preview) cannot read the
token, so it has no terminal — by design.

### 7.2 Types
```ts
interface TerminalInfo {
  id: string;             // "t_" + 12 hex
  projectId: string;      // the project open when it was created
  title: string;          // shell name, the folder's name, or the user's rename
  cwd: string;            // absolute, where the shell started
  shell: string;          // absolute path ($SHELL -l, fallback /bin/zsh)
  pid: number | null;
  cols: number; rows: number;
  createdAt: string;      // ISO
  status: "running" | "exited";
  exitCode: number | null; signal: number | null;
}
```

### 7.3 Messages (JSON text frames; one socket multiplexes every terminal)
Viewer → daemon:

| `type` | Fields | Effect |
| --- | --- | --- |
| `create` | `requestId, cols, rows, cwd?, nodeId?, title?, input?` | New shell in the open project (`error` without one). `cwd`: repo-relative (system: `<repoId>/<rel>`) or absolute; `nodeId`: the element's `path`, else its first file's folder (an element the stored map does not know falls back to `cwd`). A file → its folder, a missing path → its nearest existing parent; the result must stay inside the project root or a system repo root (symlinks resolved). `input` is typed at the first prompt **without Enter** (bracketed paste when the shell enabled it, else newlines → spaces). Answer: `created`. |
| `list` | `requestId?, projectId?` | Answer: `terminals` (default: the open project). |
| `attach` | `id` | Subscribe to output and exit. Answer: `attached` with `replay` (the scrollback), then `exit` if it already exited. A full-screen app gets a SIGWINCH nudge so it redraws. |
| `detach` | `id` | Unsubscribe. |
| `input` | `id, data` (≤ 64 KiB) | Written to the PTY as is (keys, pastes, terminal replies). |
| `resize` | `id, cols, rows` (2…1000) | Last writer wins when several viewers are attached. |
| `rename` | `id, title` (≤ 80) | Broadcasts `terminals`. |
| `clear` | `id` | Empties the replay buffer (⌘K clears the screen in the viewer). |
| `kill` | `id` | SIGHUP (SIGKILL after 2 s); the terminal leaves the list. |
| `ack` | `id, chars` | Flow control: characters of `output` rendered. The daemon pauses the PTY while any attached viewer is > 100 000 characters behind and resumes when all are < 5 000. Viewers must ack. |

Daemon → viewer: `ready { available, shell | reason, projectId }` (first
message), `terminals { projectId, terminals, requestId? }` (also broadcast to
every socket whenever a project's list changes: create, rename, exit, kill),
`created { requestId, terminal }`, `attached { id, terminal, replay }`,
`output { id, data }`, `exit { id, exitCode, signal }`, `error { requestId?, id?, message }`.

Output is UTF-8 text decoded by node-pty (multi-byte sequences split across
reads are held back until complete), so JSON strings carry it losslessly.

### 7.4 Lifecycle
- Environment: the daemon's environment minus its plumbing (`ELECTRON_RUN_AS_NODE`,
  `RUAH_PARENT_PID`, `RUAH_MCP_TOKEN`, lower-case `npm_*` script variables, …) plus
  `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=Ruah`,
  `RUAH_PROJECT_ROOT=<project root>`, and `LANG=en_US.UTF-8` when no locale is set.
- Scrollback: a 1 MiB ring per terminal (`RUAH_TERMINAL_SCROLLBACK_BYTES`), trimmed at
  line breaks; terminal queries (cursor position, device attributes, colour queries …)
  are dropped from it so a replay does not make the new viewer answer them again.
- Terminals survive viewer reloads and project switches. A project's terminals are
  killed once it has not been the open project for 1 h (`RUAH_TERMINAL_IDLE_MS`), and
  every terminal is hung up when the daemon exits. At most 32 terminals per daemon.

### 7.5 Desktop bridge addition (§5.4)
`window.ruah.openExternal(url)` opens an `http:`/`https:` URL in the default browser
(`shell.openExternal`; anything else is refused in the main process). Terminal links use
it; a plain browser uses `window.open(url, "_blank", "noopener")`.

---

## 10. Cloud providers batch B: GCP, Azure, Cloudflare, Railway, Fly.io (2026-09-24)

Five more **cloud** integrations (§6), each a read-only adapter over the provider's own
CLI and its own login. Ruah never runs a login, never stores a credential, never calls a
mutating subcommand, and never copies secrets (env vars, connection strings, admin logins,
keys) into a `CloudResource`. Adapters live in `src/integrations/cloud/<id>.ts` on a
shared base (`cloud/cli-kit.ts`) and are standalone library modules: they need only an
injectable `Runner` (exec.ts: `execFile` with an args array, 20 s timeout, redacted errors)
and the `SettingsStore` — no daemon, SessionHub or open project. They are registered only
through `registry.ts` (`cloudBatchB(deps)` / `registerCloudBatchB(registry, deps)`).

### 10.1 Providers

| id | name | CLI (tried in order) | install (Homebrew) | login | accounts |
| --- | --- | --- | --- | --- | --- |
| `gcp` | Google Cloud | `gcloud` | `brew install --cask gcloud-cli` | `gcloud auth login` | `"<configuration>/<project>"` per gcloud configuration with a project, plus `"<project>"` for other projects the login sees (`gcloud projects list`, ≤ 50) |
| `azure` | Azure | `az` | `brew install azure-cli` | `az login` | subscription ids (`az account list`, local); the default one is used when none is picked |
| `cloudflare` | Cloudflare | `wrangler` | `brew install cloudflare-wrangler` | `wrangler login` | account ids from `wrangler whoami`; passed as `CLOUDFLARE_ACCOUNT_ID` |
| `railway` | Railway | `railway` | `brew install railway` | `railway login` | workspace ids (`"personal"` for projects without one); none picked = all |
| `fly` | Fly.io | `flyctl`, `fly` | `brew install flyctl` | `fly auth login` | org slugs (`orgs list --json`); none picked = all orgs |

### 10.2 Read commands and mapping

gcloud calls always carry `--format=json --quiet` (+ `--project`, `--configuration`), az
calls `-o json --only-show-errors` (+ `--subscription`), wrangler runs from a neutral cwd.

| provider | command (all read-only) | → `type` / `service` | status |
| --- | --- | --- | --- |
| gcp | `run services list` | `container` / `cloud-run` | `ready` (latest created revision is the ready one), `deploying · <revision>`, `failed`; `url` = service URL |
| gcp | `container clusters list` | `kubernetes` / `gke`, `gke-autopilot` | `running · 3 nodes` |
| gcp | `sql instances list` | `database` / `cloud-sql/<engine>` | `running`, `stopped` (RUNNABLE + activation NEVER), else lower-cased state |
| gcp | `functions list` (gen 1 + 2) | `function` / `cloud-functions[/gen2]` | lower-cased state; `url` = trigger / service URI |
| gcp | `pubsub topics list` | `queue` / `pubsub` | — |
| gcp | `storage buckets list` | `storage` / `gcs` | — (region = location, lower-cased) |
| azure | `group list` | `other` / `resource-group` | provisioning state |
| azure | `webapp list`, `functionapp list` | `app` / `app-service`, `function` / `functionapp` | `running`, `stopped`; `url` = custom hostname, else `*.azurewebsites.net` |
| azure | `containerapp list` | `container` / `container-app` | running status; `url` = ingress FQDN |
| azure | `aks list` | `kubernetes` / `aks` | `running · 5 nodes` (power state + summed pool counts) |
| azure | `sql server list`, `postgres flexible-server list` | `database` / `azure-sql`, `postgres-flexible` | lower-cased state |
| azure | `storage account list` | `storage` / `storage-account` | `available` / provisioning state |
| cloudflare | `d1 list --json` | `database` / `d1` | — |
| cloudflare | `kv namespace list` (JSON) | `storage` / `kv` | — |
| cloudflare | `r2 bucket list` (text) | `storage` / `r2` | — |
| cloudflare | `queues list` (table) | `queue` / `queues` | `active` / `no consumers` |
| cloudflare | `pages project list --json` + `pages deployment list --project-name <p> --json` (≤ 20) | `app` / `pages` | latest production deployment: `deployed`, `deploying`, `failed`, `canceled`; `url` = custom domain, else `*.pages.dev` |
| cloudflare | Workers from the project's `wrangler.toml` / `wrangler.json(c)` (root + 3 levels, ≤ 20 files) + `deployments list --name <w> --json` | `function` / `workers` | `deployed`; tags `routes`, `environment`, `deployed-at`; `url` from the first concrete route; undeployed Workers are skipped |
| railway | `list --json` | `app` / `railway/service`; `database`/`cache` / `railway/<engine>` for DB images or names; legacy plugins | tags `project`, `environments` |
| railway | `status --json` (cwd = the open project, only if it is `railway link`ed) | one resource per service × environment | latest deployment status lower-cased (`success`, `crashed`, `building`, …); `url` = custom, else service domain; tags `project`, `environment` |
| fly | `apps list --json [--org]` + per app (≤ 50) `machines list --app <a> --json`, `volumes list --app <a> --json`; `postgres list --json` | `app` / `fly/app`, `database` / `fly/postgres` | `deployed · 2/3 machines started · fra, iad` (machines summarized: started / total, regions by count); `url` = `https://<hostname>` |
| fly | volumes | `storage` / `fly/volume` | `created · 10 GB`; tag `app` |
| fly | `mpg list --json` (newer flyctl; unknown command ignored) | `database` / `fly/managed-postgres` | status |

Ids are provider-native where one exists (GCP full resource names `//run.googleapis.com/projects/…`,
Azure ARM ids) and namespaced otherwise (`cf:d1:<uuid>`, `railway:service:<svc>:<env>`,
`fly:app:<name>`). Labels / tags become `tags`, so `ruah-node=<id>` links as in §6 (GCP
label keys cannot contain `:`; use `ruah-node` / `ruah_node`). "API not enabled" (GCP),
"subscription not registered" (Azure) and an unknown `mpg` command are empty listings, not
errors. A missing `az containerapp` extension is a per-service error naming
`az extension add --name containerapp`.

### 10.3 Contract additions (all optional, additive)

```ts
export interface IntegrationInfo {
  // … §6.1
  installCommand?: string;   // exact Homebrew install command of the provider CLI
  loginCommand?: string;     // exact login command
}
export interface CloudResource {
  // … §6.1
  url?: string;              // public URL the resource serves (Cloud Run, Pages, Fly app, …)
}
// registry.ts: CloudIntegration.sync(options: { account?: string; project?: ProjectContext | null })
// `project` lets a provider read repo config (Cloudflare Workers, Railway link); the
// daemon passes the open project, a CLI caller may pass its cwd or nothing.
```

### 10.4 States (not installed / not logged in) and quietness

| situation | `status` | `detail` | `setupHint` |
| --- | --- | --- | --- |
| CLI not on PATH (+ Homebrew dirs) | `cli_missing` | `<cli> is not installed` | `<install> && <login>` |
| installed, no login | `not_connected` | `not logged in to <cli> — <reason>` | `<login>` |
| logged in, nothing usable (gcloud without a project) | `not_connected` | `no Google Cloud project selected` | `gcloud config set project PROJECT_ID` |
| disconnected in Ruah | `not_connected` | `disconnected in Ruah (<cli> login unchanged)` | `Connect to use your <cli> login` |
| connected | `connected` | `<who> · <account noun> <account>` | — |

`installCommand` and `loginCommand` are always set for these providers. Nothing is
mandatory and nothing polls: an adapter spawns its CLI only from `info()` (GET
`/api/integrations`), `connect()` and `sync()`. `enabled()` is false while the CLI is
missing, while Ruah has it disconnected, and once a login check failed (until `info()`
sees a login again), so a "sync all" (`POST /api/cloud/sync` without `providers`) never
spawns an unusable CLI and never reports it as an error. A disconnected provider makes no
CLI call at all, even in `info()`. When every listing of a sync fails with an auth error,
the sync reports one `credentials expired or missing — run: <login>` instead of one error
per service.

The viewer shows these states as **Connected / Not logged in / Not installed /
Disconnected** with the install and login commands, each copyable and — when the app's
integrated terminal (§7) is available — "Run in terminal" (a new tab with the command
typed, not executed). The Cloud page shows a "Connect a provider" list of every cloud
provider while none is connected.

### 10.5 Live health (for later wiring)

Each adapter exports a pure `healthOf(nativeState)` →
`"healthy" | "degraded" | "down" | "deploying" | "unknown"` (`HealthState` in
`cli-kit.ts`). It accepts the provider's native enum values (`RUNNABLE`, `Running`,
`SUCCESS`, `started`, …) and the adapter's own `status` strings (the part before ` · `).
Fly's takes a second argument `"app" | "machine" | "volume"` because `created` is a
volume's normal state but a machine that has not started. The adapters do not set any
live-health field on `CloudResource` yet; `status` carries the state.

### 10.6 Known gaps

- **Wrangler** cannot list an account's Workers, so only Workers declared in the open
  project's wrangler config are shown (none when syncing without a project). `r2 bucket
  list`, `queues list` and `whoami` have no JSON output and are parsed from text; `pages
  … list` use `--json` and fall back to the table on an older wrangler. The Pages
  deployment "Status" column is a relative time or a stage word, mapped heuristically.
- **Railway**: deployment status and domains need the open project folder to be
  `railway link`ed (`status --json`); other projects show services without status.
  `list --json` / `status --json` shapes differ across CLI versions; both GraphQL-edge
  and plain-array shapes are accepted.
- **Fly.io**: machines and volumes are read per app (≤ 50 apps, 4 at a time); a larger
  org gets a note in `errors`. JSON key casing varies by flyctl version (`Name` / `name`);
  both are read.
- **Azure**: `containerapp` needs the extension on older `az`; SQL databases inside a
  server and MySQL flexible servers are not listed.
- **GCP**: Cloud Run jobs, App Engine and Compute Engine VMs are not listed.
- `/api/integrations` is cached for 15 s (§6), so "Check again" right after a login can
  show the previous state for a few seconds.

## 12. Multi-repo systems management (2026-09-24)

Creating and managing multi-repo systems (§1.5, docs/MULTI-REPO.md) without
editing JSON. Everything is **optional**: a single-repo project looks and
works exactly as before, and the system endpoints answer 409 for it.

**Layering.** The logic is a standalone library, `src/system/*` (no daemon
dependency): `manage.ts` (create / add / remove / rename / rebuild / rescan),
`status.ts` (git status), `github.ts` (`gh`), `suggestions-store.ts` (review
state), `suggest-run.ts` (one agent pass, pluggable `RunAgent`). The
`ruah app system` CLI (§12.7) and the daemon's `/api/system/*` (§12.6) both
call it. The daemon adds only two things: changes to the open system go
through its live store (validated, written atomically, broadcast as
`architecture` reason `saved`; the project stays open, no switch), and
"Suggest connections" runs on the **current agent** as a normal turn.

### 12.1 Files (all next to `ruah.system.json`)
| File | Content | Written by |
| --- | --- | --- |
| `ruah.system.json` | §1.5 (`{ version: 1, name, repos: [{ id, path }] }`, paths relative) | create / add / remove / rename |
| `architecture.json` | the system map (§1.5); hand edits and accepted suggestions are merged on every rebuild | rebuild, accept, the viewer, agents |
| `.ruah/suggestions.json` | `{ version: 1, pending: StoredSuggestion[], rejected: RejectedSuggestion[], lastRun? }` (§12.5); commit it to share review decisions | suggest, accept, reject |
| `.ruah/system-scan.json` | `{ version: 1, builtAt, repos: { [id]: { scannedAt, source: "architecture.json" \| "scan" \| "missing", type, nodes, warning? } } }`: facts of the last build, for status | every rebuild |

Repo folders are never written by management calls, with one exception: a
per-repo **rescan** of a repo that already has its own `architecture.json`
refreshes that file (as `ruah app scan` would, hand edits merged), so the
system rebuild reuses it. A repo without one is scanned in memory; no file is
created in it. **Remove never deletes files**: it only takes the repo out of
`ruah.system.json` (and drops its pending suggestions).

Rules for the system folder: it must not be one of the repos, and a folder
that holds a single-repo map (`architecture.json` without `ruah.system.json`)
is refused (the system map would overwrite it). Repo paths must be existing
folders (realpath) not already in the system; ids match
`^[a-z0-9][a-z0-9-]{0,62}$`, are unique, and are derived from the folder name
when omitted (`Billing_Service` → `billing-service`, then `-2`, `-3`, …).

### 12.2 Types
```ts
interface GitStatus { branch: string | null /* null = detached */; upstream: string | null;
  ahead: number; behind: number; dirty: number /* changed + staged + unmerged + untracked */; head: string | null }
interface RepoStatus { id: string; path: string /* as in the file */; root: string /* absolute */; exists: boolean;
  git: GitStatus | null /* null = not a git work tree */; gitError?: string;
  lastScanAt: string | null; scanSource: "architecture.json" | "scan" | "missing" | null;
  type: string | null /* service, frontend, worker, library, infra, gateway */;
  nodes: number /* elements of the repo in the system map, below its repo node */; warning?: string }
interface SystemStatus { name: string; dir: string; file: string; builtAt: string | null; repos: RepoStatus[] }
interface GithubRepo { nameWithOwner: string; name: string; description: string | null; url: string;
  isPrivate: boolean; isArchived: boolean; updatedAt: string | null; defaultBranch: string | null }
interface StoredSuggestion { id: string /* "s-" + sha1(from, to, lower-cased label)[:10], stable across runs */;
  from: string; to: string; label?: string; kind?: string; confidence: number /* 0..1 */;
  evidence: string[] /* "<repoId>/<path>:<line>[-<line>]", verified to exist */; reason?: string;
  proposedAt: string; agentId?: string }
interface RejectedSuggestion { id: string; from: string; to: string; label?: string; rejectedAt: string }
interface SuggestionsView { pending: StoredSuggestion[] /* still valid against the current map */;
  rejected: RejectedSuggestion[]; lastRun: { at: string; agentId?: string; proposed: number; dropped: number; error?: string } | null;
  running: { startedAt: string; agentId: string } | null }
```
Git status is `git -C <root> status --porcelain=v2 --branch` (execFile, args
array, 15 s timeout); ahead/behind are relative to the upstream (0 without one).

### 12.3 GitHub
Browsing uses the user's own `gh auth` (Ruah stores no token):
`gh repo list [<owner>] --json name,nameWithOwner,description,url,isPrivate,isArchived,updatedAt,defaultBranchRef --limit <n>`
(owner `^[A-Za-z0-9][A-Za-z0-9-]{0,38}$`, empty = the logged-in user).
Cloning is `gh repo clone <owner/name> <parentDir>/<name>` and **only happens
on an explicit request** (the Clone button, `repos/add` with `github`, CLI
`add gh:owner/name`); the repo must match `owner/name` and the target must not
exist. `gh` missing → 400 with an install hint.

### 12.4 Rename (decision)
Renaming a repo id is **allowed** and applied, in one call, to everything Ruah
stores that names the repo's elements: `ruah.system.json`; the system
`architecture.json` (the repo node, every `<old>:*` id, `parent`, `repo`,
`path` / `files[]` / `evidence` `<old>/*`, edge ends, workflow ids and steps);
pending and rejected suggestions (ids recomputed); `.ruah/links.json` (work
items); `.ruah/system-scan.json`; and, in the daemon and in the CLI through
`RUAH_HOME`, the system project's chats (`TurnRecord.nodeId`, header
`lastNodeId`) and cloud links (`~/.ruah/projects/<id>/cloud.json`
`manualLinks`, `linkedNodeId`). Then the map is rebuilt, so hand edges and
accepted suggestions keep pointing at the same elements. Refused: an id that
does not match `^[a-z0-9][a-z0-9-]{0,62}$` (400), one already in the system,
one that is already an element of the map such as the shared `postgres` node,
or any rename while "Suggest connections" runs (409). Not rewritten: agent
session transcripts (the agent's own history; old ids there are plain text)
and per-viewer UI state kept in the browser.

### 12.5 Connections: deterministic first, agent second
1. **Deterministic signals** (zero tokens, `src/system/signals.ts`): compose /
   k8s / terraform that deploy or link other repos, env / config / source URLs
   and `*_URL` / `*_HOST` values naming another service, queue / topic names
   published in one repo and consumed in another, internal packages. They are
   the top-level `source: "scan"` edges of every rebuild, each with
   `evidence`. `GET /api/system/signals` lists them.
2. **Suggest connections** (optional): the prompt (`suggest-prompt.ts`) lists
   the top-level services, the known edges, where each repo lives, and the
   edges the user rejected before (so no tokens are spent on them); the agent
   answers JSON only; `parseSuggestions` validates it (listed services only, no
   self edges, confidence 0..1, evidence `<repoId>/<path>:<line>` of an
   existing file line, no duplicate of an existing edge). Valid proposals are
   stored as `pending` (a repeat refreshes the same id; previously rejected
   ones are dropped). **Accept** → an edge `{ from, to, label?, kind?, source:
   "suggested", evidence }` saved to the map and kept by every rebuild.
   **Reject** → remembered in `rejected`, never proposed again (until
   "unreject").
   - **Daemon: the current agent, as a normal turn** (`SessionHub.runTaskTurn`):
     recorded in the active chat (bubble text "Suggest connections between the
     N repos of <name>", the full prompt as its context pack), broadcast as
     `turn.started` / `stream` / `turn.finished` to every viewer, counted in
     usage, permission requests shown as usual. Chosen over a hidden one-shot
     so the user sees what the agent read and what it cost, and can cancel it
     like any turn. A busy agent → 409 (no queueing). The turn's answer (all
     `text` chunks) is parsed when it finishes; a turn that does not end with
     `end_turn` records `lastRun.error`. The agent's cwd is the system folder
     with every repo as an additional directory (Claude); ACP agents get the
     cwd only (docs/MULTI-REPO.md); evidence is verified on the daemon either way.
   - **CLI: pluggable.** `--agent claude` runs a one-shot, read-only Claude
     Agent SDK query (tools Read / Grep / Glob / LS only, everything else
     denied, the user's Claude Code settings and login); `--print-prompt`
     prints the prompt for any other agent and `--reply-file <file|->` feeds
     its answer back.

### 12.6 HTTP
Every endpoint below passes the Origin check of `/ws` (§2.2 rule 10; 403),
GETs included (they read the machine's repos and `gh`). POST bodies are JSON
≤ 64 KiB, validated by `src/contracts/system.ts` (400). Errors: 400 invalid,
404 unknown repo / suggestion / missing folder, 409 conflict or no system open
(`"no project open"`, `"the open project is not a multi-repo system"`), 422
invalid `ruah.system.json`, 503 without the service.

| Method + path | Body / result |
| --- | --- |
| `GET /api/system` | `SystemStatus` of the open system |
| `POST /api/system/create` | `{ dir, name?, repos: { path, id? }[], open?: boolean }` → `{ project: ProjectInfo \| null, created, added: string[], dir }`. Writes `<dir>/ruah.system.json` (folder created when missing); when one exists there, the repos not yet in it are added ("Add another repo…" into an existing system). Then opens it as the current project (default; the usual `project` / `architecture` / `chats` broadcasts). Works with any project open, or none. |
| `POST /api/system/repos/add` | `{ path }` or `{ github: { repo: "owner/name", parentDir? } }`, plus `id?` → `SystemStatus`. `github` clones into `parentDir` (default: the system folder's parent) first. |
| `POST /api/system/repos/remove` | `{ id }` → `SystemStatus` (files untouched) |
| `POST /api/system/repos/rename` | `{ id, newId }` → `SystemStatus` (§12.4) |
| `POST /api/system/repos/rescan` | `{ id }` → `{ status, nodes, edges, ms }` (§12.1) |
| `POST /api/system/rescan` | `{}` → `{ status, nodes, edges, ms }`: rebuild every repo |
| `POST /api/rescan` | while a system is open: rebuilds the system (`{ ok, nodes, edges, ms }`) instead of scanning its folder as a repo |
| `GET /api/system/signals` | `{ edges: ArchEdge[] }`: the deterministic top-level `scan` edges with evidence |
| `GET /api/system/suggestions` | `SuggestionsView` |
| `POST /api/system/suggestions/run` | `{ minConfidence?, maxSuggestions? }` → **202** `SuggestionsView` (`running` set). Proposals land when the turn finishes: poll `GET …/suggestions` or watch `turn.finished`. 409 when a run is going, the agent is busy, or the system has fewer than two repos. |
| `POST /api/system/suggestions/accept` | `{ id }` → `{ edge, suggestions: SuggestionsView }`; the edge is saved through the store (broadcast `architecture`, `by.kind: "user"`) |
| `POST /api/system/suggestions/reject`, `…/unreject` | `{ id }` → `SuggestionsView` |
| `GET /api/system/github/repos?owner=&limit=` | `{ repos: GithubRepo[] }` (newest first); no system needed |
| `POST /api/system/github/clone` | `{ repo: "owner/name", parentDir }` → `{ path }`; no system needed |

Repos added while an agent session is live reach Claude's additional
directories on its next session (a new chat, a reset, or a restart); the
file / context / terminal endpoints resolve them at once.

### 12.7 CLI (`ruah app system`, no daemon needed)
`<system>` = the folder holding `ruah.system.json` (or the file); commands
without it take `--system <dir>`, default the current directory. Exit codes:
0 ok, 2 usage / validation / not found / conflict, 1 other failures.
```
init <folder> [--repo <path>|<id>=<path>]... [--name <n>] [--force]
add [<system>] <path | <id>=<path> | gh:owner/name> [--id <id>] [--into <dir>]
remove <id>
rename <id> <new-id>
status [<system>] [--json]          # SystemStatus as JSON, or a table
signals [<system>] [--json]         # { edges }: deterministic, zero tokens
scan [<system>] [--out <path>] [--dry-run]
rescan <id>
suggest [<system>] [--agent claude] [--model <m>] [--min-confidence <n>] [--json]
        [--print-prompt | --reply-file <file|->]
suggest [<system>] --list | --accept <n|id>... | --reject <n|id>... | --unreject <id>... [--json]
```
`--accept 1` refers to the position in the list as printed before the call.
Accepting writes `architecture.json`; a running daemon picks it up through its
file watcher.

### 12.8 Context pack and ids (addition to §3)
For an element of a system (it has `repo`, or its id is `<repoId>:…`, stored or
expanded) the pack gets one line after `path:`:
`repo: <repoId> at <absolute repo folder> (paths "<repoId>/<path>" are inside it)`,
so the agent can open system paths whatever the folder layout. Namespaced ids
work unchanged in `GET /api/context/:id` and `GET /api/expand/:id` (URL-encode
the `:`), expanded ids (`<repoId>:<node>/<entry>`), diagram ids (`arch:<id>`),
breadcrumbs, search (elements without a path show their repo), and the draw.io
export (one page per repo, XML-safe ids).

### 12.9 Viewer
Self-contained, mounted once (`<SystemDialogs />` from
`ui/src/components/system/`) and opened with `openSystemDialog()` from
`ui/src/lib/system.ts`; nothing in the layout depends on it. Entry points: the
start screen's **New system…**; the project menu's **Add another repo…** for a
repo project (creates a system with this repo plus the picked ones in a folder
the user picks; the repo keeps its own map), or **Repos…** / **Suggest
connections…** for a system project. The manager has two tabs: *Repos*
(`ReposPanel`: branch, ↑↓, changes, elements, last scan; add from disk or
GitHub, rename, rescan, remove) and *Connections* (`ConnectionsPanel`:
detected edges, the agent's proposals with confidence and clickable
`file:line` evidence, accept / reject, the rejected list). Both panels are
exported so a later page layout can host them.
