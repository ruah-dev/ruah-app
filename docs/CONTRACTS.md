# CONTRACTS.md — ruah coupling contracts

These contracts are the only coupling between the viewer and the daemon (`ruah app`). It started with three (§1 `architecture.json`, §2 the WebSocket protocol, §3 the context pack); every later section adds one area, numbered in the order it was written (there is no §4). Both sides copy the TypeScript types verbatim and validate at the boundary with zod. Nothing else crosses the wire.

Written 2026-09-16 against ACP `protocolVersion: 1`, `@agentclientprotocol/sdk` 1.4.0, `@agentclientprotocol/claude-agent-acp` 0.78.0.

Conventions that apply to every section:

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
3. `prompt` is accepted when `agent.status.state === "idle"` (or `"error"`: the agent is restarted). Accepted prompts produce `turn.started` (carrying the exact context pack that was sent, for transparency) and then `stream` events until `turn.finished`. **While the current agent is `starting`** (e.g. right after `agent.set` to a cold agent, or while it applies its saved model / mode) the prompt is **queued** instead of refused: `turn.started{queued:true}` at once (the viewer shows the user bubble with "waiting for <agent>…"), then — once the agent is idle — the prompt is sent and a second `turn.started` (without `queued`) follows. One prompt can wait at a time (another one → `error{busy, turnId}`). `cancel` of a queued turn ends it with `turn.finished{cancelled}` without it ever reaching the agent; an agent or chat switch does the same, a project switch keeps it waiting in the background (§13.1). If the agent fails to start, the queued turn ends `turn.finished{error, error:"<agent> did not start: <reason>"}`. A queued or cancelled turn is stored in its chat like any other. Otherwise (`busy`, `stopped`) → `error{busy, turnId}`.
4. `permission.request` blocks the agent until `permission.response` arrives. There is no daemon-side timeout in Phase 1. `permission.resolved` is echoed so a second viewer tab stays consistent.
5. `cancel` makes the daemon (a) answer every pending `permission.request` of that turn with ACP `{outcome:"cancelled"}`, (b) send ACP `session/cancel`, (c) wait up to 15 s for the ACP prompt response, then `turn.finished{stopReason:"cancelled"}`. If the agent does not respond in 15 s the daemon kills and respawns it and sends `turn.finished{stopReason:"error"}` + `agent.status`.
6. Running turns (the open project's and background ones, §13.1) are cancelled only when the **last** viewer disconnects and none reconnects within 5 s (`RUAH_DISCONNECT_GRACE_MS`); another open tab or a page reload keeps them running. A viewer that (re)connects gets the running turn's events so far in `chat.history` (`running: true`) and any pending `permission.request` again (§13.1).
7. `stream{kind:"text"}` chunks are forwarded as they arrive, no batching. The viewer appends them to the current assistant segment. A `tool_call` event closes the current text segment; the next text chunk opens a new one (matches t3code's assistant segmentation).
8. `tool_call` / `tool_result` carry the full merged state, so the viewer upserts by `toolCallId`.
9. `diff` is emitted in addition to the `tool_call`/`tool_result` that contained it, so the viewer can render diffs without parsing tool content.
10. The daemon only listens on `127.0.0.1` by default and checks the `Origin` header: `http(s)://localhost:*`, `http(s)://127.0.0.1:*`, plus `--allow-origin <glob>` (needed for Lovable previews, e.g. `https://*.lovable.app`).
11. Frames larger than 1 MiB are rejected with `bad_message`.
12. **Switching projects does not cancel a running turn** (2026-09-24, §13.1): it keeps running in the background and re-attaches when the project is opened again. Switching the agent or the chat still cancels it (`turn.finished{cancelled}`), and so does a project switch when background agents are off or the background limit is reached.

### 2.3 Companion HTTP endpoints (same origin as the WebSocket)

| Method + path | Purpose | Notes |
| --- | --- | --- |
| `GET /` and any non-`/api` path without an extension | viewer `index.html` (SPA fallback) | static dir from `--viewer <dir>`, default bundled |
| `GET /assets/*` | viewer assets | `Cache-Control: public, max-age=31536000, immutable` |
| `GET /api/health` | `{ ok: true, version, agent: AgentState, project: string \| null, viewerBuild: string \| null }` | `project`: the open project's id. `viewerBuild` (2026-09-26, §2.6): the id of the viewer build the daemon serves now, from the `<meta name="ruah-build">` of `<viewer>/index.html`; null without a viewer directory or for a build without the tag |
| `GET /api/architecture` | current `Architecture` JSON | same payload as the WS message |
| `GET /api/context/:nodeId` | `text/plain` context pack for the node | used by "Copy context" in the node popover |
| `GET /api/file?path=<rel>` | `{ path, lang, content }` | inside root only; max 512 KiB; binary → 415; missing → 404 |
| `GET /api/expand/:nodeId` | `Expansion` (§1.6): the level below a stored or expanded element | `nodeId` URL-encoded; 404 unknown element or path, 422 not expandable (no path, a symbol, a file without an outline); Origin checked like `/ws` (403) |
| `GET /api/expand-peek?id=<id>&id=<id>…` | `{ counts: { [id]: number \| null } }` direct child counts for "N inside" chips, without expanding (null = not expandable) | max 200 ids; Origin checked (403) |
| `POST /api/rescan` | re-run the scanner on the served repo, merging hand edits; `{ ok, nodes, edges, layers, ms }` | Origin checked like `/ws` (403 otherwise); result is broadcast as `architecture` reason `saved`; 422 if the result fails validation |
| `POST /api/attachments?name=<file name>` | raw image body → `{ id, name, mimeType, size, width?, height? }` | §5.6; Origin checked (403); 409 without a project; 413 over 10 MB; 415 not an image |
| `GET /api/attachments/:id` | the stored image | §5.6; `id` must match `^[a-f0-9]{64}\.(png\|jpg\|gif\|webp)$` (400 otherwise), 404 unknown |
| `GET /api/export/drawio` | the open project as an uncompressed draw.io file (`<mxfile>`): page "Overview" (top level, title block, legend), one page per element with children (named by breadcrumb, e.g. `api / routes`), one page "Workflow: <name>" per workflow, page "Specifications" (tables of every element, link and workflow) | `Content-Type: application/vnd.jgraph.mxfile; charset=utf-8`, `Content-Disposition: attachment; filename="<name>.drawio"`; 409 without a project. Elements and links are UserObjects whose properties carry the specs (`ruahId, type, layer, parent, repo, path, tech, files, description, notes, links, cloud, issues`; links: `from, to, kind, source, evidence`); drillable elements `link` to their page (`data:page/id,<pageId>`). Linked cloud resources and issues (§6) are included read-only when the integrations answer within 8 s, otherwise the export notes it on the Specifications page. Deterministic. CLI: `ruah app export drawio <repo> [--out <file>]` (local files only: `.ruah/links.json`, cached `cloud.json`) |
| `GET /api/usage/summary?range=24h\|7d\|30d` | `{ range, totals: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd: number\|null, turns }, series: { t, agentId, model, inputTokens, outputTokens, costUsd\|null }[], byModel: { agentId, model, turns, inputTokens, outputTokens, costUsd\|null }[] }` | per-turn usage recorded by the daemon in `~/.ruah/usage.jsonl` (all repos); `t` = ISO bucket start (hourly for 24h, daily otherwise); `costUsd` only when the agent reports it |
| `GET /api/arch`, `POST /api/arch/ops` | map ops for `ruah app mcp` (§1.7) | loopback + capability token only; no Origin allowed |
| `GET /api/usage/limits` | `{ providers: { agentId, name, status: "available"\|"unavailable"\|"unknown", windows: { id, label, kind: "session"\|"weekly"\|"other", usedPercent: number\|null, resetsAt: string\|null }[], note? }[] }` | Claude: SDK `get_usage` + streamed `rate_limit_event` (port of t3code `claudeUsageLimits.ts`); other agents `unknown` unless their ACP usage updates say otherwise |
| any other `/api/*` path or method | `404 { error }` (2026-09-26) | never the SPA fallback: a client calling an endpoint this daemon lacks (e.g. an older daemon) gets an error, not `index.html` with 200. Map edits go through `architecture.save` on the WebSocket (there is no `PUT /api/architecture`) |

### 2.4 Example: one complete turn

```json
{"type":"hello","protocol":1,"client":"architects-canvas/0.1.0"}
```
```json
{"type":"architecture","reason":"initial","revision":3,"root":"/Users/dev/code/acme-platform","path":"/Users/dev/code/acme-platform/architecture.json","architecture":{"version":1,"name":"acme-platform","nodes":[],"edges":[],"workflows":[]}}
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

### 2.6 Viewer build id and auto-reload (2026-09-26)

A window left open on an older viewer reloads onto the newer one the daemon serves (after
`pnpm ui:build`, or a daemon restarted with another `--viewer`), without losing anything.

- **Build id.** Every `vite build` of the viewer (`ui/vite.config.ts`) makes one id
  (`<base36 time>-<random>`) and stamps it twice: into the client code
  (`import.meta.env.VITE_RUAH_BUILD_ID`) and into the prerendered `index.html` as
  `<meta name="ruah-build" content="<id>">`. The dev server (`vite dev`) has none and never compares.
- **Daemon.** `GET /api/health` → `viewerBuild` reads that tag from `<viewer>/index.html` on
  demand, cached by the file's mtime + size, so a rebuild that replaces the directory while the
  daemon runs is seen at once (no restart). `null`: no viewer directory, or a build without the tag.
- **Viewer** (`ui/src/lib/build-reload.ts`, `ui/src/components/shell/useBuildReload.tsx`): asks
  1.5 s after the socket opens, when the window gets focus or becomes visible, and every 30 s (hidden
  windows too). Only a page served by that daemon compares (same origin; not a dev server or a
  Lovable preview pointed at a daemon). When the ids differ:
  - **Silent reload** when nothing would be lost: no turn running or waiting for a permission in the
    chat in front, no typed text in a text field (the composer, a dialog, a rename; the terminal's
    hidden input does not count), no image attached in a composer and not sent (attachments live
    in memory; composers report them through `setComposerPending`), the map not in Edit mode or
    saving, no open dialog or menu. The reload waits 600 ms so debounced view-state saves go out;
    the per-project view state (§13.5) brings back the page, map level and panels.
  - **Otherwise it says so**: a 10 s toast at the top ("Ruah was updated — Reload when you are
    ready (<reasons>)", away from the composer being typed in) and an "Update ready" chip in the top
    bar's status area that reloads on click (its tooltip says what holds the reload back when it
    shows). The window still reloads by itself later, once it is idle and in the background
    (hidden or unfocused). If the daemon serves this window's own build again (restarted with the
    previous `--viewer`, a rollback), the chip and the toast go away.
  - **No "Where you left off" for what the user just watched**: every reload for a build (silent
    or from the chip / toast) stores the open project's id in `sessionStorage`
    (`ruah.buildReload.resumed`, read once). On the reloaded page that project's resume card
    (§13.4) counts as dismissed for its current `lastViewedAt`; another project, or a later visit,
    shows it as usual.
  - **Never a loop**: before reloading, the served id is stored in `sessionStorage`
    (`ruah.buildReload.v1`); a window that still differs from that same id after reloading only
    prompts. Without `sessionStorage` there is no automatic reload.
- Complements the stale-chunk recovery (`ui/src/lib/stale-build.ts`): a lazy route chunk that no
  longer exists after a rebuild reloads once per minute at most.

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

The user selected the node above on an architecture diagram of the repository at /Users/dev/code/acme-platform. Treat that node as the scope of the request. Open the listed path and files first; search elsewhere only if they do not answer the question. If you change files outside this node, say so explicitly.

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
- Turns (`prompt`) always belong to the active chat; `chat.new` / `chat.open` cancel a running turn first. A project switch does not (§13.1). The viewer therefore asks before it opens another chat of the project (or a new one) while a turn runs in the chat in front ("Stop the agent?", 2026-09-26); the recent-chats strip shows which chat is working.

### 5.3 HTTP additions
| Method + path | Body / result |
| --- | --- |
| `GET /api/projects` | `{ current: ProjectInfo \| null, recent: ProjectInfo[] }` (most recent first, pinned on top) |
| `POST /api/projects/open` | `{ path, chatId? }` → `ProjectInfo`. With `chatId` the project opens on that chat (one `chats` frame with that `activeChatId`, then its `chat.history`; unknown ids are ignored; on the already-open project it acts like `chat.open`). Scans first when there is no `architecture.json`; opens as `system` when `ruah.system.json` exists. Broadcasts `project`, `architecture`, `chats`. |
| `POST /api/projects/create` | `{ parentDir, name, git?: boolean }` → `ProjectInfo`. Creates the folder (must not exist), optional `git init`, an empty `architecture.json` (valid, zero nodes), then opens it. §20.1 adds templates, the first commit, GitHub, systems and a `created` report. |
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

§13.3 adds `notify(opts)` and `onNotificationClick(callback)`. §15.4 adds `onMenuCommand(callback)` (application-menu commands).

2026-09-25 (optional, Settings → Features & behaviour, off by default):
`setLauncherShortcut(on: boolean): Promise<boolean>` registers / releases ⌥Space
as a global shortcut in the main process (`globalShortcut`, released on quit;
resolves false when another app owns it), and `onLauncherShortcut(callback)`
is called when it is pressed (the window is restored and focused first; the
viewer opens its ⌘K launcher). Older desktop builds lack both.

### 5.5 Behaviour details (daemon, 2026-09-23)
- After `hello`: `project`, then (with a project) `architecture` and `agent.status`, then `chats` and the active chat's `chat.history`. Launcher state: `project{null}` + `agent.status{state:"stopped"}` only.
- On a switch: a running turn keeps running in the background (§13.1; nothing is announced — its events go to the activity feed). Only with background agents off or at the background limit is it announced `turn.finished{cancelled}` (and stored; the old project's `chats` follows) first. Then `project`, `architecture` (or `architecture.error` if the file is invalid), `chats`, `chat.history` (when a chat is active), `agent.status` (`starting` → `idle`, or `idle` at once for a warm agent).
- Launcher state: `/api/architecture`, `/api/context/*`, `/api/file`, `/api/rescan` answer `409 { error: "no project open" }`; WS `prompt`/`chat.*`/`mode.set`/`model.set`/`session.reset` answer `error{bad_message, "no project open"}`; `agent.set` only changes the agent used for the next project.
- The active chat on open is the one last active in that project — persisted in `~/.ruah/projects/<id>/state.json` (`{ version: 1, activeChatId: string | null, … }` — §13.5 lists the other fields; written on every chat switch, so it survives daemon restarts; a chat id that no longer exists is ignored; unknown keys are kept) — else the most recently updated chat, else none (`activeChatId: null`). A `prompt` without an active chat creates one titled after the prompt. `chat.new` reuses the active chat when it has no turns (its title is "New chat" until the first prompt).
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

More cloud providers, live health on `CloudResource`, watch mode (`cloud.watch` / `cloud.updated`) and the `ruah app cloud` CLI: see §9 (and §10 for GCP, Azure, Cloudflare, Railway, Fly.io).

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

## 8. Ruah engines: guard, opt, watch (2026-09-24)

Optional CLIs behind `/api/engines/*`. Each one is also usable on its own
(`ruah guard`, `ruah opt`, `ruah watch`, or the package bin). When the binary
is missing the route answers **424** with `{ error }` that includes
`npm i -g @ruah-dev/cli @ruah-dev/<tool>`. `GET /api/engines/status` reports
that without spawning anything. Nothing here changes agent permissions.

| Method + path | Body / query | Result |
| --- | --- | --- |
| `GET /api/engines/status` | — | `{ guard, opt, watch }` each `{ installed, install }` |
| `POST /api/engines/guard/scan` | `{}` | `ruah guard scan . --json` on the open project (secrets + policy rules). Findings are a report only. |
| `GET /api/engines/guard/audit` | `last` (optional, non-negative integer) | `{ entries, count, file }` from `ruah guard audit` |
| `POST /api/engines/opt/usage` | `{}` | `ruah opt usage $RUAH_HOME/usage.jsonl --json`: top spenders, waste signals, suggestions. Missing log → empty report. |
| `POST /api/engines/watch/replay` | `{ chatId, turnId }` | Renders that turn from `$RUAH_HOME/projects/<projectId>/chats/<chatId>.jsonl` via `ruah watch render`. `{ path, name, turns }` |
| `GET /api/engines/watch/view?name=` | basename `turn-….html` under `$RUAH_HOME/replays` only | `text/html` replay. The viewer shows it in an iframe and can reveal the file. |

409 when no project is open. 404 when the chat or turn is missing. POST still
requires an allowed `Origin` (§2.2).

## 9. Cloud providers and live status (2026-09-24)

Extends §6 (cloud family) with five more providers and with **what is really
running right now**: a normalized health per resource, a watch mode that keeps
it fresh while someone looks, and a standalone CLI. Everything stays read-only
and CLI-first: Ruah runs each provider's own CLI with its own login; no token
is stored, logged or copied into a resource. Code: `src/integrations/cloud/*`
(adapters), `health.ts`, `cloud-sync.ts`, `watch.ts`, `cloud-cli.ts` — none of
them depends on the daemon (`SessionHub`), so the CLI runs them standalone.

### 9.1 Providers
| id | CLI (setupHint when missing) | Accounts (`ConnectBody.account`) | Resources (read-only) |
| --- | --- | --- | --- |
| `vercel` | `vercel` (`brew install vercel-cli && vercel login`) | teams (`vercel teams list`), passed as `--scope <slug>` | projects (`vercel projects list`), the newest production and preview deployment per project (`vercel list --all`, then `vercel list <project>` for projects it missed, ≤ 25), domains (`vercel domains list`); all `--format json` |
| `supabase` | `supabase` (`brew install supabase/tap/supabase && supabase login`) | organizations (`supabase orgs list`), a filter on the project list | projects (`supabase projects list`); per active project (≤ 25) edge functions (`supabase functions list --project-ref <ref>`) and preview branches (`supabase branches list --project-ref <ref>`; the default branch is the project); all `-o json`. Never needs the database password. |
| `kubernetes` | `kubectl` (`brew install kubectl && kubectl config use-context <context>`) | kubeconfig contexts (`kubectl config get-contexts -o name`, current from `config current-context`), passed as `--context=<ctx>` | `kubectl get <kind> --all-namespaces -o json --request-timeout=10s` for deployments, statefulsets, daemonsets, cronjobs, services, ingresses, and pods (only summarized per workload). `kube-system`, `kube-public`, `kube-node-lease` and the `default/kubernetes` service are skipped. |
| `netlify` | `netlify` (`brew install netlify-cli && netlify login`) | teams (`netlify api listAccountsForUser`), a filter on `account_slug` | sites (`netlify api listSites --data {"filter":"all"}`, ≤ 50) with their newest deploy (`netlify api listSiteDeploys --data {"site_id":…,"per_page":1}`) |
| `hetzner` | `hcloud` (`brew install hcloud && hcloud context create <project>`) | hcloud contexts (`hcloud context list`), passed as `--context <name>` | servers, load balancers, volumes (`hcloud <kind> list -o json`) |

`IntegrationInfo` works as in §6.1: `cli_missing` + `detail: "<cli> not installed"` + the
setupHint above; `not_connected` with the login command (`vercel login`, `supabase login`,
`netlify login`, `hcloud context create <project>`) when the CLI answers "not logged in";
`error` otherwise (e.g. `context kind-dev: cluster unreachable (…)`). Accounts are validated
against the CLI's own list before they are stored or passed (`--account=--flag` is refused).

Resource ids: `vercel:project:<id>`, `vercel:deployment:<url>`, `vercel:domain:<name>`,
`supabase:project:<ref>`, `supabase:function:<ref>:<slug>`, `supabase:branch:<id>`,
`k8s:<context>:<namespace>:<deployment|statefulset|daemonset|cronjob|service|ingress>:<name>`,
`netlify:site:<id>`, `hcloud:<server|load-balancer|volume>:<id>`. Kubernetes uses the
namespace as `region`; Kubernetes labels / Hetzner labels become `tags` (so `ruah-node=<id>`
links a resource, §6 linking).

Safety details: every run goes through `exec.ts` (argv array, no shell, 20 s timeout,
redacted messages that never echo arguments); stdin is closed (`input: ""`) so no CLI can
wait on a prompt; `vercel` and `netlify` run from `$TMPDIR` so a linked `.vercel/` /
`.netlify/` in the daemon's cwd cannot change the scope; `supabase` runs from
`$TMPDIR/ruah-supabase-cli` because it writes `supabase/.temp/` into its cwd. Server IPs,
database hosts, build environments and e-mail addresses are never copied; a load balancer's
public address and ingress hosts are (they are the entry points).

### 9.2 `CloudResource` additions (all optional; §6.1 unchanged otherwise)
```ts
type CloudHealth = "healthy" | "degraded" | "down" | "deploying" | "unknown";
interface CloudResource {
  // … §6.1 fields …
  health?: CloudHealth;          // absent = the provider has no health notion for it (domains, volumes, ClusterIP services)
  healthDetail?: string;         // "2/3 ready · 1 crash-looping · 14 restarts", "latest production deployment failed · previous one still live"
  observedAt?: string;           // ISO time of the sync that read this state
  replicas?: { ready: number; desired: number };                                  // workloads (Kubernetes, ECS services)
  pods?: { running: number; pending: number; crashLoop: number; restarts: number }; // Kubernetes workloads
  url?: string;                  // where it is served (production URL, deployment URL, ingress URL, App Platform live URL)
  hosts?: string[];              // ingress hosts, custom domains, load balancer addresses
  createdAt?: string;            // ISO (deployments, projects, sites)
}
```
`CloudIntegration` (registry.ts) gains an optional `available?(): boolean` — false when its CLI
is not installed or its last login check said "not logged in" (until `info()` sees a login
again); the §10 adapters fold the same into `enabled()`. `syncable(p)` = `enabled() &&
available() !== false` is the one gate: "Sync all" (`POST /api/cloud/sync` without
`providers`) and the watch loop cover `syncable()` providers only and drop old errors of
skipped ones; naming a provider still syncs it. `url` is shared with §10.3 (one field).
`CloudSyncBody.providers` accepts up to `KNOWN_CLOUD_PROVIDERS.length` ids (12: every
registered cloud provider), and `sync()` receives the open project (§10.3) from both the
Sync button and the watch loop.

### 9.3 Health mapping
| Provider | Rule |
| --- | --- |
| Kubernetes deployment / statefulset / daemonset, ECS service | ready vs desired: all ready → healthy; none → down (deploying if a rollout just started and nothing crash-loops); some → degraded; a rollout in progress (generation not observed, updated < desired, surplus old pods, statefulset revision change, ECS second deployment / `IN_PROGRESS`) → deploying; crash-looping pods (`CrashLoopBackOff`, `ImagePullBackOff`, `ErrImagePull`, `Create*Error`, `InvalidImageName`, `RunContainerError`) or `ProgressDeadlineExceeded` / ECS `FAILED` rollout → degraded; desired 0 → unknown ("scaled to 0") |
| Kubernetes cronjob | suspended → unknown; running job → healthy; last success ≥ last schedule → healthy; else degraded ("last run did not succeed"); never ran → unknown |
| Kubernetes service / ingress | LoadBalancer with an address → healthy, without → deploying; ingress with a load-balancer address → healthy, without → deploying; other services: none |
| Vercel project | newest production deployment (CANCELED ignored): READY → healthy; BUILDING / INITIALIZING / QUEUED → deploying; ERROR → degraded when an older READY production deployment is still live, else down; none listed → unknown. Deployment rows carry `status` + `url` + `createdAt`, no health (the project counts once). |
| Supabase | project `ACTIVE_HEALTHY` → healthy, `ACTIVE_UNHEALTHY` → degraded, `COMING_UP`/`RESTORING`/`UPGRADING`/`RESIZING` → deploying, `INACTIVE` (paused)/`PAUSING`/`GOING_DOWN`/`*_FAILED`/`REMOVED` → down; function `ACTIVE` → healthy, `THROTTLED` → degraded, `REMOVED` → down; branch `MIGRATIONS_PASSED`/`FUNCTIONS_DEPLOYED` → healthy, `CREATING_PROJECT`/`RUNNING_MIGRATIONS` → deploying, `*_FAILED` → down |
| Netlify site | newest deploy building (new … processed, retrying) → deploying; error → degraded if a published deploy is live, else down; otherwise published → healthy, nothing published → down |
| Hetzner | server `running` → healthy, `initializing`/`starting`/`rebuilding`/`migrating` → deploying, `off`/`stopping`/`deleting` → down; load balancer from its targets' checks: all healthy → healthy, some unhealthy → degraded, all → down, no targets → unknown |
| DigitalOcean | droplet `active`/`new`/`off`; App Platform: a deployment in progress → deploying ("previous version live"), else active phase (`ACTIVE` healthy, `ERROR` down); databases `online`/`creating`/`migrating`/`resizing`/`offline`; kubernetes `running`/`provisioning`/`upgrading`/`degraded`/`error`; load balancer `active`/`new`/`errored` |
| AWS | EC2 `running`/`pending`/`stopped`…; RDS `available` (+ backing-up) / modifying… / stopped, failed…; ElastiCache; ELBv2 `active`/`provisioning`/`active_impaired`/`failed`; CloudFront `Deployed`/`InProgress`; Lambda `State` when present (list-functions usually omits it) |
| §10: Google Cloud, Azure, Cloudflare, Railway, Fly.io | the adapter's pure `healthOf(state)` (§10.5) applied by the kit after every sync (`withLiveHealth`, `cli-kit.ts`) to the native state in `status` (the part before ` · `); the rest of the status becomes `healthDetail`, "2/3 machines started" becomes `replicas`. No status (buckets, topics, KV, D1) and Azure resource groups: no health. Fly volumes use `healthOf(state, "volume")`. |

Unlisted native states map to `unknown`. The viewer and the CLI count `healthy` as "running".

### 9.4 Watch mode and push
- Viewer → daemon: `{ type: "cloud.watch", on: boolean }` — sent while the Cloud page is open
  or "Show on map" is on (re-sent after a reconnect; `on: false` when both end). A closed
  socket counts as `on: false`.
- Daemon: while ≥ 1 socket watches, `CloudWatcher` re-syncs each `syncable()` provider of the
  open project every `RUAH_CLOUD_WATCH_MS` (default 45 000 ms). Per provider: never two syncs
  at once (a manual Sync of the same provider + account shares the running one); after a sync
  that failed outright (thrown, or only errors) the next one waits interval · 2^failures,
  capped at 10 min, reset by a success; a Sync-button sync postpones the next poll. No viewer
  watching → no timer, no CLI runs. `RUAH_CLOUD_WATCH=0` turns watch mode off.
- Daemon → viewers (broadcast), after every sync (watch loop or `POST /api/cloud/sync`) and
  every `POST /api/cloud/link`:
  ```ts
  { type: "cloud.updated"; root: string;       // project the snapshot belongs to
    syncedAt: string | null; providers: string[]; // synced in this update ([] = link change)
    failed: string[];                          // providers whose sync failed outright
    errors: { provider: string; message: string }[];
    resources?: CloudResource[] }              // whole snapshot; absent = nothing visible changed
  ```
  The viewer ignores it for another project; without `resources` it refreshes `observedAt` of
  the synced providers and the errors. Sync results still land in `~/.ruah/projects/<id>/cloud.json`.

### 9.5 Viewer
Cloud page: a strip "12 running · 1 degraded · 1 down · 2 deploying" (clicking degraded / down
toggles the Unhealthy filter) with a Live indicator, a Health column (dot, label,
ready/desired, detail), down / degraded counts per provider section, and a details drawer
(health, replicas, pods, URL, hosts, created, checked) that the Map's Cloud level shares.

### 9.6 CLI: `ruah app cloud`
No daemon and no open project needed; the provider list is the daemon's registry, so every
registered cloud adapter appears. Reads `$RUAH_HOME/integrations.json` for account selections
and never writes any Ruah file.

| Command | Output |
| --- | --- |
| `ruah app cloud providers [--json]` | each cloud provider: `connected` / `not logged in` / `not installed` / `disconnected in Ruah` / `error`, detail and `fix: <command>`; `--json`: `{ providers: IntegrationInfo[] }` |
| `ruah app cloud list [opts]` | resources per provider (name, service, region, health · detail[, → element]); `--json`: `{ resources, syncedAt, errors }` (§6 shape, with `observedAt`) |
| `ruah app cloud status [opts]` | `Cloud: 12 running · 1 down …`, one line per provider, "Needs attention" (down, degraded, deploying), "Could not read"; `--json`: `{ summary, providers: [{ id, name, summary, failed }], unhealthy, errors, exitCode }` |
| `ruah app cloud watch [opts] [--interval <s>]` | first poll: a summary per provider (+ unhealthy resources); then one line per change (`+` added, `-` gone, `healthy → deploying · detail`); `--json`: one object per line (`snapshot`, `unhealthy`, `change`, `error`); Ctrl-C stops |

Options: `--provider <id>` (repeatable; default: every enabled provider that is connected —
not-installed / logged-out ones are skipped quietly, erroring ones are reported),
`--account <a>` (with exactly one `--provider`), `--repo <path>` (links resources to that
repo's `architecture.json` elements and its manual links, read-only), `--json`,
`--interval <s>` (watch, ≥ 5, default 45).
Exit codes: `0` ok · `1` something is down (`status`) or a named provider is not usable ·
`2` usage error · `3` a provider could not be read, or none is connected (`status`, `watch`).

### 9.7 Adding a provider
Extend `CliCloudAdapter` (`src/integrations/cloud/cli-adapter.ts`): set `id`, `name`,
`binName`, `setupHint`, `accountPattern`, `accountNoun`, optionally `runOptions`; implement
`accounts()`, `check()` and `list()` with pure, exported mappers (fixtures under
`test/fixtures/integrations/`); map native states with `healthFrom()` / `workloadHealth()`
(`health.ts`); register it in `IntegrationsService`. It then appears in Integrations, the Cloud
page, sync-all, the watch loop and `ruah app cloud`.

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
`cli-kit.ts`, = `CloudHealth` of §9). It accepts the provider's native enum values (`RUNNABLE`, `Running`,
`SUCCESS`, `started`, …) and the adapter's own `status` strings (the part before ` · `).
Fly's takes a second argument `"app" | "machine" | "volume"` because `created` is a
volume's normal state but a machine that has not started. Wired (2026-09-24): the kit sets
`health` / `healthDetail` / `replicas` from it on every synced resource with a status (§9.3),
so these providers count in the Cloud page strip, its filters and `ruah app cloud status`.

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

## 11. Infrastructure-as-code in the map (2026-09-24)

`ruah app scan` (and the daemon's first-open scan and `POST /api/rescan`) also reads the repo's infrastructure as code and shows **how things actually run**: which code runs where, deployed by which tool, on what cloud resources. Deterministic, no AI, no network; implemented as a standalone library in `src/scan/iac/` (no daemon dependency). Everything below is additive and optional: maps of repos without IaC only gain `infra` details on code packages that have a Dockerfile or compose service.

### 11.1 What is read

| Tool | Files | Becomes |
| --- | --- | --- |
| Terraform / OpenTofu | `*.tf`, `*.tf.json` (roots = dirs no other config uses as a local module; `modules/` dirs only when instantiated) | a group per root × provider (`Terraform: AWS`); resources → children by category; local modules instantiated (`module.db.aws_db_instance.this`, the caller's literal inputs resolved); remote modules → one child classified by `source` |
| Kubernetes | `*.yaml` / `*.yml` documents with `apiVersion` + `kind` (multi-document), outside Helm charts | workloads (Deployment, StatefulSet, DaemonSet, Job, CronJob, Pod, Rollout) and routes (Ingress, Traefik IngressRoute, HTTPRoute), HelmChart / HelmRelease / Argo Application CRs; Services fold into the workloads they select |
| Kustomize | `kustomization.yaml` graphs | roots (kustomizations nothing else references) rendered in memory: `namespace`, `namePrefix` / `nameSuffix`, `images`, `replicas`, strategic-merge patches of replicas / images; one group per environment (`overlays/<env>`, `envs/`, `environments/`, `clusters/`, or an env-like dir name); raw manifests join the group of their namespace |
| Helm | `Chart.yaml`, `values.yaml`, `templates/*.yaml` (nothing rendered) | a group per chart; workloads from the templates' kinds with image / replicas / port resolved from the `.Values.*` paths they use; ingress hosts from values; well-known dependencies (postgresql, redis, …) |
| Ansible | playbooks (YAML lists of plays with `hosts:`), `roles/<r>/tasks`, INI / YAML inventories (host names only) | one group per Ansible project; a child per host pattern (`server`) with roles as details; products the roles / packages install (nginx, postgres, …) as children; `docker_container` images → code |
| Dockerfiles | `Dockerfile`, `Dockerfile.<x>`, `<x>.Dockerfile`, `Containerfile` | `infra` details on the code package it builds (runtime base, ports, workdir, cmd, images) — no new node |
| Compose | as before (`detectors/compose.ts`) | `infra` details on the compose nodes |
| CI | `.github/workflows/*.yml` (listed directly: `.github` is a hidden dir the walker skips), `.gitlab-ci.yml` | a `CI/CD` group: a child per pipeline that builds or deploys, its registries and PaaS targets; other workflows are details |

**Never read:** `terraform.tfstate*`, `*.tfvars`, `.env*`, Secret / SealedSecret / ExternalSecret data (name and namespace only, by regex), Ansible `group_vars` / `host_vars` / inventory variables, values under keys that look secret. Settings keep literal values of whitelisted keys only. **Bounds:** Terraform 3,000 files, YAML 4,000, Dockerfiles 500, workflows 200; each file ≤ 2 MiB (manifests ≤ 512 KiB) and read at most once per scan; test-data dirs (`fixtures`, `testdata`, `__tests__`, `__mocks__`) are skipped. The fixture monorepo scans in a few ms.

### 11.2 Map shape

- **Top level:** code packages as before, plus one node per IaC group with `layer: "infra"`: `Terraform: AWS` (`type: "cloud"`), `Kubernetes: prod` / `Helm: api` / `Ansible` (`type: "cluster"`), `CI/CD: GitHub Actions` (`type: "pipeline"`). Ids: `tf-<provider>`, `k8s-<env|namespace>`, `helm-<chart>`, `ansible`, `ci`. With more than 6 groups, a tool with several groups gets one umbrella node (`Kubernetes`, `Terraform`) holding them, so the top level stays readable.
- **Children** (`parent` = group, id `<group>.<name>`, `path` and `files` = the declaring file): `type` by category — `datastore` (RDS, Cloud SQL, managed DBs), `cache`, `storage`, `queue`, `search`, `registry`, `cluster`, `container` (k8s workloads, ECS tasks), `worker` (CronJob / Job), `service` (VMs, ECS services, Cloud Run, releases), `function`, `frontend`, `server` (Ansible host groups), `gateway` (ingress, API gateway), `loadbalancer`, `dns`, `cdn`, `firewall`, `secret`, `pipeline`, `external` (PaaS). Layers: `edge` (gateway, loadbalancer, dns, cdn, firewall), `services` (compute, workloads, pipelines), `data` (stores, queues, registries), `infra` (cluster, secret, other). The new types are aliased where the viewer and draw.io had no kind: `cloud` → cluster, `pipeline` → worker, `registry` → storage.
- **Noise is folded, not drawn:** IAM, networking (VPC, subnets, security groups, EIPs), `random_*`, `null_resource`, `time_*`, `tls_*`, data sources, locals, policy attachments, node groups, ConfigMaps, Secrets, RBAC, NetworkPolicies, … go into `infra.details` of the item they belong to (a folded resource that references exactly one item) or of the group.

### 11.3 Node detail fields (`ArchNode.infra`, optional)

```ts
interface InfraDetails {
  tool: "terraform" | "kubernetes" | "kustomize" | "helm" | "ansible" | "compose" | "docker" | "ci" | (string & {});
  kind: string;          // aws_db_instance | Deployment | CronJob | dependency | hosts | workflow | registry | Dockerfile | provider | environment | namespace | chart | inventory | pipelines …
  address?: string;      // tool-native: module.db.aws_db_instance.this | prod/Deployment/worker | api/Deployment/api | web
  source?: string[];     // "path:line" of the declaration(s), <= 10
  settings?: Record<string, string>; // replicas, image, ports, schedule, service, namespace, engine, engine_version, instance_class, allocated_storage, multi_az, kubernetes_version, hosts, roles, triggers, builds, deploys, base, expose, …
  details?: string[];    // folded resources / objects, <= 40 ("aws_iam_role.eks", "Secret db-credentials (values not read)")
  hints?: string[];      // names a live cloud resource may carry (§11.6)
}
interface Workflow { /* … */ source?: "scan" | (string & {}) } // "scan" = derived by the scanner
```

Receivers that save an architecture MUST round-trip `infra` and `Workflow.source` (the viewer spreads nodes and workflows; a workflow the user edits loses `source` and becomes theirs).

### 11.4 Edges and workflows

- Edges carry `source: "scan"` and `evidence` (`path:line`, sorted, <= 10): workload → code `runs` (`kind: "deploy"`; by image — CI builds, compose, Dockerfile location / name suffix / COPY sources / workspace filters, package names); IaC item → the top-level infra node `runs` (the RDS instance runs the `Postgres` the code uses; an S3 bucket → `AWS S3`); Terraform references (`sql`, `cache`, `objects`, `messages`, `uses`, `runs on`) and glue resources (DNS records, LB listeners / target groups) as `resolves` / `routes`; route → workload labelled with its host/path; workload → workload / infra kind / code service from env and ConfigMap host names (`HTTP`, `gRPC`, `calls`, `cache`, `sql`); Kubernetes workloads using a Secret / ConfigMap that Terraform writes (`kubernetes_secret`) → the resources it references; pipeline → code `builds`, → registry `pushes`, → targets `deploys`.
- **Lifting:** an edge whose ends sit on different levels is also added between their ancestors at the level where both are visible (`Kubernetes: prod → worker [runs]`), so the top level shows how things run.
- **"How it ships" workflows** (`source: "scan"`): per pipeline and code package it builds, `Ship <package>` = `[package, pipeline, registry, …the workloads in the deploy targets that run its image]`. Targets come from `kubectl apply -k/-f`, `kustomize build`, `kubectl set image / rollout restart`, `helm upgrade --install`, `terraform|tofu [-chdir] apply`, `ansible-playbook`, `docker compose up`, `gcloud run deploy`, `aws ecs update-service`, PaaS CLIs and actions; `${{ env.X }}` / `$X` resolve from literal env, anything else is a `*` wildcard. Pipelines that deploy but build nothing: `Deploy: <pipeline>`.

### 11.5 Provenance and re-scans (`src/scan/merge.ts`)

- IaC nodes have no `origin` (scanned, §1.7) and are regenerated by every scan; hand edits (`description`, `notes`, `x` / `y`) survive by id like on any node. An IaC node the scan no longer produces is dropped **even when its file still exists** (the resource was removed, or IaC scanning is off); elements with `origin` `user` / `agent` are kept. Code packages with `docker` / `compose` details keep the ordinary rule.
- Workflows with `source: "scan"` are replaced by the new scan's; all other workflows are kept as before.
- System architectures (§1.5) carry each repo's `infra` (`source` paths prefixed `<repoId>/`), inner edge `evidence` and workflow `source`.

### 11.6 Linking live cloud resources (`src/integrations/linking.ts`)

After manual > tag > unique exact name > unique normalized name: (a) an ambiguous name match is narrowed to the one IaC node whose `type` fits the resource type (a `container` resource named `worker` → the `worker` Deployment, not the `worker` package); (b) `infra.hints` are matched against the resource name, its `Name` / `name` / `app` / `app.kubernetes.io/name` / `app.kubernetes.io/instance` / `k8s-app` / `service` tag, and `<namespace>/<name>` — exact, then normalized, narrowed by type when several match. Hints: Terraform address, `type.label`, literal `identifier` / `name` / `bucket` / …, `Name` tag; Kubernetes name, `namespace/name`, `kind/name`, app labels, the names of the Services selecting it; Helm workload and chart names; Ansible host pattern and inventory host names. Links decided this way report `linkSource: "name"`.

### 11.7 Context pack and draw.io

- Context pack (§3.1), after `layer:` when the element has `infra`: `infra: <tool> <kind> <address>`, `declared in: <path:line>, …`, `settings: k=v; …` (<= 12), `folded: …` (<= 12). Nothing changes for elements without `infra`.
- draw.io: elements with `infra` get the properties `infra`, `declaredIn`, `settings`, `folded` and tooltip lines; the Specifications page gets an **Infrastructure as code** table (element, tool / kind / address, declared in, settings, folded, cloud link hints).

### 11.8 Optional everywhere

- **CLI:** `ruah app scan <repo> --no-infra` skips IaC. `ruah app infra <repo> [--json] [--kind terraform|k8s|helm|kustomize|ansible|compose|docker|ci]…` prints what the IaC scan finds — groups with their resources / workloads, declaration lines and key settings, code packaging, "how it ships" workflows, links — and writes nothing (`--kind` repeatable or comma-separated; `--json` → `{ repo, kinds, nodes, edges, workflows, ms }`; unknown kind or missing repo → exit 2).
- **Daemon** — per project, persisted in `$RUAH_HOME/projects/<id>/state.json` as `scan.infra` (default `true`); the first-open scan and `POST /api/rescan` use it. System (multi-repo) scans always include IaC.

| Method + path | Body / result |
| --- | --- |
| `GET /api/projects/scan-options[?id=<projectId>]` | `{ projectId, options: { infra: boolean } }` (default: the open project; none open → 409) |
| `POST /api/projects/scan-options` | `{ id?, infra? }` → `{ projectId, options }`; same Origin rule as every POST (403); bad body 400; unknown project 404 |

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

## 13. Background agents, activity feed, resume and view state (2026-09-24)

For a user who switches projects all day: an agent keeps working in the
project you left, every viewer sees what agents do in every project, the
desktop app notifies you, and each project remembers where you left off.
Every part is optional: the feature flags in §13.6 turn background agents
and notifications off, and the resume / activity data is plain files in
`$RUAH_HOME` that the CLI reads without a daemon (`ruah app resume`,
`ruah app activity`, §13.7). Code: `src/serve/activity.ts` (feed),
`src/activity/log.ts` (persistence), `src/resume/*` (resume library + CLI),
`src/serve/activity-http.ts` (HTTP), `src/serve/session.ts` (background
turns), `src/serve/bridge-pool.ts` (pinning); viewer `ui/src/lib/activity.ts`,
`ui/src/lib/view-state.ts`.

### 13.1 Background agents

- **A project switch does not cancel a running turn.** The turn (or a prompt
  still queued while its agent starts, §2.2 rule 3) keeps running on its
  bridge; its stream events are recorded into its chat as before, but not
  sent to viewers (they show another project). When it finishes it is stored
  in its chat and reported as an `activity` event (§13.2) — viewers of other
  projects get no `turn.finished`. A queued prompt of a background agent is
  sent once that agent is idle.
- **Pinned in the pool.** A bridge with a running or queued turn is never
  evicted: not by the pool cap, not by the warm TTL, not by a release (even
  with `RUAH_WARM_TTL_MS=0`). When the turn ends, the bridge is treated like a
  fresh release (kept warm for the TTL, or stopped without one). The cap of
  live agents (`RUAH_MAX_LIVE_AGENTS`, 4) can be exceeded only by pinned
  bridges; the background limit keeps that bounded.
- **Limit.** At most **3** turns run outside the open project
  (`RUAH_MAX_BACKGROUND_TURNS`, capped at `RUAH_MAX_LIVE_AGENTS - 1`). A
  switch that would exceed it cancels the leaving project's turn as before
  (`turn.finished{cancelled, error: "cancelled: 3 turns already run in other
  projects (background limit)"}`, stored). With `backgroundAgents: false`
  (§13.6) every project switch cancels (the pre-2026-09-24 behaviour).
- **Re-attach.** Opening a project that has a background turn: the agent
  running it becomes the current agent (even if another one was picked
  meanwhile), the turn's chat becomes the active chat (a `chatId` passed to
  `POST /api/projects/open` is ignored then), and the usual switch frames
  follow — `chat.history` includes the turn with `running: true`, no
  `stopReason` and its events so far; `agent.status` says `busy`; then every
  still-pending `permission.request` of that turn is sent again (after
  `chat.history`). Further `stream` frames continue the turn; `cancel` works
  on it as on any turn.
- **Permissions.** A request made in the background waits (no timeout, §2.2
  rule 4); it is reported as `activity` `permission.requested` and counted in
  `waitingPermission`. `permission.response` is routed to whichever bridge
  asked, so it can be answered from any project; normally the viewer opens the
  project (e.g. from the notification) and answers the re-sent request.
- **`running: true` on reconnect.** The same `chat.history` + pending
  `permission.request` re-send happens after `hello`, so a page reload in the
  middle of a turn shows it and its open question again.
- **What stays the same.** `agent.set` and chat switches (`chat.new`,
  `chat.open`, `chat.delete` of the active chat) still cancel the running
  turn — including a `chat.open` of another chat right after re-attaching
  (the viewer's "open project at chat" does that when the chat differs from
  the running turn's). §2.2 rule 6 covers background turns too: when the last viewer is gone
  for 5 s, every running turn is cancelled. Daemon shutdown stores every
  running turn as `cancelled` ("Ruah stopped").
- **Limitations.** Map edits through the `ruah_*` tools (§1.7) are refused
  for an agent whose project is not the open one (the tool tells the agent
  why); code edits are unaffected. `ruah-verify` (engines) runs only after
  turns of the open project.

### 13.2 Activity feed (WebSocket, every viewer)

```ts
interface ActivityEvent {
  id: string;                 // uuid
  kind: "turn.started" | "turn.finished" | "permission.requested"
      | "permission.answered" | "agent.error" | "map.changed" | (string & {});
  projectId: string; projectName: string; projectRoot?: string;
  chatId: string | null; turnId?: string; agentId?: string;
  summary: string;            // one line, ≤ 200 chars, e.g. 'Finished "Add tests" · 2 files edited'
  at: string;                 // ISO
  background: boolean;        // its project / chat was not in front, or no viewer was connected
  stopReason?: StopReason;    // turn.finished
  error?: string;             // turn.finished (error / limit), agent.error
  requestId?: string;         // permission.*
  files?: string[];           // turn.finished: files the agent edited (edit/delete/move tool calls + their diffs that completed — a denied or cancelled edit is not listed; ≤ 20)
  mapChanges?: number;        // turn.finished, map.changed
}
interface ProjectActivity {
  projectId: string; projectName: string; projectRoot?: string;
  running: number;            // turns running or queued (the open project's included)
  waitingPermission: number;  // permission requests waiting for an answer
  unread: number;             // sum of `chats`
  chats: Record<string, number>;  // unread per chat id ("none" = a turn without a chat)
  lastEventAt?: string;
}
type AppFeatures = { backgroundAgents: boolean; notifications: "background" | "always" | "off" };
```

Daemon → viewer (sent to **every** socket, whatever project it shows):

| Frame | When |
| --- | --- |
| `{ type: "activity.snapshot", projects: ProjectActivity[], recent: ActivityEvent[], settings: AppFeatures, maxBackgroundTurns: number }` | after `hello` (after `chats` / `chat.history`), and to everyone after `settings.set`. `projects` lists only projects with something running, waiting or unread (of the recent list and live turns); `recent` = the last 50 events, oldest first. |
| `{ type: "activity", event: ActivityEvent, project: ProjectActivity }` | every event; `project` = that project's counts after it |
| `{ type: "activity.project", project: ProjectActivity }` | counts changed without an event (unread markers cleared) |

Viewer → daemon: `{ type: "activity.read", projectId, chatId? }` clears the
unread marker of a chat (or all of the project's).

**Unread markers.** `turn.finished` and `permission.requested` events with
`background: true` add 1 to their chat's marker, persisted in the project's
`state.json` (`unread`, §13.5), so badges survive restarts. A marker is
cleared when the user views the chat: the project is opened on it (with a
viewer connected), `chat.open` / `chat.new` makes it active, a viewer says
`hello` while it is active, or `activity.read`.

**Persistence.** Every event (not `activity.project`) is appended to
`$RUAH_HOME/activity.jsonl` (one JSON object per line; compacted to the newest
2000 events once the file passes 1 MB; unparseable lines are skipped).

**HTTP** (same data, for CLIs and the launcher):

| Method + path | Result |
| --- | --- |
| `GET /api/activity?since=<ISO or 24h/90m/7d>&projectId=&limit=100` | `{ projects: ProjectActivity[], events: ActivityEvent[] (oldest first, newest `limit`, max 2000), settings: AppFeatures, maxBackgroundTurns }`; 400 bad `since` |
| `POST /api/activity/read` | `{ projectId, chatId? }` → `{ ok: true, project: ProjectActivity }`; Origin checked (403) |

### 13.3 Desktop notifications (Electron)

The renderer decides, the main process shows. `ui/src/lib/activity.ts` calls
`window.ruah.notify` for an `activity` event of kind `turn.finished` or
`permission.requested` when `settings.notifications` is:
`"background"` (default) — and the event is `background`, or the window is
not focused (`document.hasFocus()`), or its project is not the open one;
`"always"` — always; `"off"` — never. Title: `"<project>: agent finished"`
(/ `failed` / `turn cancelled` / `agent stopped`) or `"<project>: permission
needed"`; body: the event's `summary`.

Preload additions to `window.ruah` (§5.4), typed as `RuahDesktopBridge` in
`ui/src/lib/contracts.ts`:
```ts
notify?(opts: { title: string; body: string; projectId: string; chatId?: string | null;
                projectRoot?: string; silent?: boolean }): Promise<boolean>;   // false = not shown
onNotificationClick?(cb: (t: { projectId: string; chatId: string | null; projectRoot: string | null }) => void): () => void;
```
Main (`ruah:notify` IPC) validates the input (text stripped of control
characters, title ≤ 120, body ≤ 300, ids `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`,
absolute root), shows an Electron `Notification` and, on click, restores and
focuses the window and sends `ruah:notification-click` to the renderer;
`daemon.ts` then opens that project and chat (`openActivityTarget`, also
usable from a feed). A plain browser shows no notifications.

### 13.4 "Where you left off": `GET /api/projects/:id/resume`

`src/resume/resume.ts` computes it from `$RUAH_HOME` and the repo only — no
SessionHub, no daemon (the CLI uses the same code). The daemon adds `live`.

```ts
interface ResumeInfo {
  project: { id; name; root; kind: "repo" | "system"; lastOpenedAt: string | null };
  lastViewedAt: string | null;   // when the user last left the project (switch away / daemon stop)
  lastChat: { id; title; agentId; updatedAt; turnCount;
              lastPrompt: string | null; lastReply: string | null } | null;  // active chat (else newest); ≤ 200 chars each
  lastFocus: { nodeId: string; name: string; at?: string } | null;           // last focus.set; name from architecture.json
  since: { from: string | null;  // = lastViewedAt (null: everything logged)
           turnsFinished; turnsFailed;    // turnsFailed: stopReason error or cancelled
           permissionsRequested;
           files: string[]; filesTotal;   // files agents edited (completed edit tool calls only), most recent first (≤ 20)
           mapChanges;                    // sum of map.changed
           events: ActivityEvent[] };     // the last 20
  unread: number;
  live?: { running: number; waitingPermission: number };   // only from a running daemon
  git: { available: true; branch: string | null /* detached */; head: string | null;
         upstream: string | null; ahead: number | null; behind: number | null;
         dirty: number; dirtyPaths: string[] /* first 5 */;
         lastCommit: { hash; subject; author; at } | null }
     | { available: false; reason: string };   // "not a git repository", "git is not installed", timeout
  ruah: { initialized: false }                  // no .ruah/ folder
      | { initialized: true; tasks: { name; status; executor?; files? }[]; error?: string };
  view: Record<string, unknown> | null;         // §13.5
  attention: number;
}
```

- **git:** two read-only calls in parallel — `git status --porcelain=v2
  --branch -z` and `git log -1` — no shell, 3 s timeout, `GIT_OPTIONAL_LOCKS=0`,
  cached per repo root for 5 s.
- **ruah:** only when the repo has `.ruah/`: `ruah task list --json` (5 s
  timeout, `src/integrations/ruah.ts` `activeRuahTasks`); tasks that are
  `done`, `merged` or `cancelled` are left out; a missing CLI or failure is
  reported in `error`.
- **attention** (ranking of `ruah app resume` without a project):
  `100 × waitingPermission + 10 × unread + 5 × running + 2 × (turns finished
  or failed since you left) + in-progress ruah tasks + (1 if the tree is dirty)`;
  ties: most recently opened first.
- 400 invalid id, 404 unknown project (never opened and not the open one).

### 13.5 Per-project state and view state

`$RUAH_HOME/projects/<id>/state.json` (§5.5) now holds, all optional, unknown
keys kept:
```ts
{ version: 1,
  activeChatId?: string | null,           // §5.5
  lastViewedAt?: string,                   // §13.4, set when the project stops being the open one
  lastFocus?: { nodeId: string; at: string },  // focus.set (§2.1) of the open project
  unread?: Record<string, number>,         // §13.2 markers per chat id
  view?: Record<string, unknown>,          // viewer-owned view state
  viewUpdatedAt?: string }
```

The **view state** is opaque to the daemon (the viewer stores map drill path,
zoom/pan, open panels, active page …). Rules: a JSON **object** (not an array
or null), at most **16 KB** serialized (UTF-8), nested at most 16 levels.

| Transport | Save | Load |
| --- | --- | --- |
| WebSocket | `{ type: "view.save", projectId, view }` (any project, not only the open one); a refused view → `error{bad_message, "view.save: view is N bytes (max 16384)"}` / `"… must be a JSON object"` | — |
| HTTP | `POST /api/projects/:id/view` `{ view }` → `{ ok: true, updatedAt }`; 413 over 16 KB, 400 not an object / bad id, 403 Origin | `GET /api/projects/:id/view` → `{ view: object \| null, updatedAt: string \| null }` |

The shell's part (`view.shell`, `ui/src/lib/view-restore.ts`) stores only a **project page**
(`/map`, `/agent`, `/tasks`, `/cloud`, `/preview`, `/?view=project`): while an app-wide page is
open (Home `/`, Chats, Usage, Integrations, Settings, Extensions) the project keeps the project page it
had, and an app-wide page stored by an older viewer restores as `/map` (2026-09-26 — a switch
back to a project used to land on Home or Settings).

The viewer helpers (`ui/src/lib/daemon.ts` `saveViewState` — debounced 400 ms
per project over the socket, HTTP when it is down, refuses > 16 KB —
`fetchViewState`, and the `useViewState(projectId)` / `useResume(projectId)`
hooks in `ui/src/lib/view-state.ts`) are what the layout uses.

### 13.6 Feature flags (`$RUAH_HOME/settings.json`)

Top-level keys of the settings file (§5.7), read through `SettingsStore.features()`:

| Key | Values | Default | Effect |
| --- | --- | --- | --- |
| `backgroundAgents` | `true` / `false` | `true` | `false`: a project switch cancels the running turn (§13.1) |
| `notifications` | `"background"` / `"always"` / `"off"` | `"background"` | §13.3 |

Missing or invalid values read as the default. Viewer → daemon
`{ type: "settings.set", backgroundAgents?, notifications? }` writes them and
broadcasts a new `activity.snapshot` (whose `settings` carry them) — for the
Settings screen. Environment: `RUAH_MAX_BACKGROUND_TURNS` (default 3, 0 = off).

### 13.7 CLI (no daemon needed)

```sh
ruah app resume [<repo-or-project-id>] [--json] [--limit <n>] [--daemon <url> | --offline]
ruah app activity [--since <duration|ISO>] [--project <repo-or-id>] [--json] [--limit <n>] [--daemon <url> | --offline]
```

- `resume <repo-or-id>`: the §13.4 report for one project (a folder never
  opened in Ruah works too); `--json` prints `ResumeInfo`. Without an
  argument: every recent project whose folder exists (`--limit`, default 20),
  highest `attention` first; `--json` prints `{ projects: ResumeInfo[], daemon: boolean }`.
- `activity`: projects with unread / running / waiting counts and the events
  since `--since` (default `24h`; `90m`, `7d`, `2w`, or an ISO time) from
  `activity.jsonl`; `--json` prints `{ since, daemon, projects: ProjectActivity[], events: ActivityEvent[] }`.
- Both read `$RUAH_HOME` directly. Live counts (running turns, waiting
  permissions) come from a daemon at `--daemon` (default `$RUAH_DAEMON_URL`,
  else `http://127.0.0.1:4177`) when one answers `GET /api/activity` within
  600 ms; otherwise they are omitted (and the text output says so).
  `--offline` never asks. Exit codes: 0 ok, 1 unknown project / folder, 2 bad
  arguments.

## 14. Per-project cloud scope (2026-09-25)

Cloud resources belong to a project. Before this, the Cloud page and `ruah app cloud` listed
everything the connected accounts could see, so a freelancer opening one client's repo saw
every other client's Vercel projects. Now every resource carries a **scope** — whether it is
this project's and why — decided deterministically (no AI, no tokens) from the repo, and the
project's accounts are the only ones synced for it. Code: `src/integrations/scope/` (a
standalone library: no daemon, no network, bounded file reads), used by the daemon
(`IntegrationsService`), the Cloud page (through it), `ruah app cloud` and the draw.io export.

### 14.1 `<repo>/.ruah/cloud.json` (committable, no secrets)

```ts
interface ScopeFile {
  version: 1;
  name?: string;                   // project name matched against project= tags (default: the repo's names, §14.2)
  accounts?: {                     // the provider accounts this project lives in
    provider: string;              // a cloud provider id (§9.1, §10.1)
    account?: string;              // IntegrationInfo.accounts[].id: team slug, doctl / kube / hcloud context,
                                   // AWS profile, GCP project, Azure subscription, Cloudflare account,
                                   // Railway workspace, Fly org, Supabase org, Netlify team; absent = the selected one
    whole?: boolean;               // true: everything in the account is this project's
  }[];
  include?: (string | { id: string; provider?: string; name?: string })[]; // added by hand (resource ids)
  exclude?: (string | { id: string; provider?: string; name?: string })[]; // removed by hand (wins over everything)
}
```

- zod-validated (`ScopeFileSchema`, `src/contracts/integrations.ts`). Written pretty (2 spaces,
  trailing newline) with stable ordering: accounts by provider + account, refs by provider,
  name, id; duplicates merged; an id in both lists stays excluded only; empty lists omitted;
  an untouched project gets no file. A ref's `name` is informational (readable diffs).
- Written **only** by an explicit user action (the POSTs below, `ruah app cloud scope add|
  remove|reset|accounts add|remove`) and only when the content changes. Reads, syncs, the watch
  loop and the CLI's list / status / watch / scope never write it.
- An invalid file (not JSON, schema error, > 1 MiB) is reported (`scope.files[].error`, a warning
  on the Cloud page, the CLI's `scope` output), treated as empty, and never overwritten: edits
  answer 409 (`ruah app cloud scope …` exits 1) until the user fixes or deletes it.
- Multi-repo systems (§12): each repo's own file plus the system folder's file. The scope is the
  union of the repos' scopes (reasons prefixed `<repoId>: `); the system folder's `exclude` wins
  over every repo; edits from the app go to the system folder's file; `accounts` are the union.

### 14.2 Evidence (deterministic)

Each match gives a reason (shown on the row) and a confidence:

| Confidence | Evidence |
| --- | --- |
| manual | `include` ("added by you"); an account with `whole: true` ("in account X"); `exclude` ("removed by you", beats everything) |
| proof | link files: `.do/*.yaml` App Platform spec (`name` → the App; `databases[].cluster_name` → the managed database; `domains[].zone` → the DNS domain), `supabase/config.toml` `project_id` and `supabase/.temp/project-ref`, `fly.toml` `app`, `.vercel/project.json` `projectId` (+ `projectName`) and `.vercel/repo.json` projects, `wrangler.toml\|json\|jsonc` (Worker / Pages names incl. `[env.*]`, D1 ids, KV ids, R2 buckets), `.netlify/state.json` `siteId`, `.firebaserc` projects (GCP resources in them), `serverless.yml` `service` (functions and stacks `<service>-*`), `samconfig.toml` `stack_name` (`aws:cloudformation:stack-name` tag); the Railway project the folder is `railway link`ed to (the adapter tags its services `railway-link`) |
| proof | infrastructure as code (§11): an exact `infra.hints` match (meaningful name) on a node whose Terraform type belongs to the resource's provider (`aws_*` → aws, `digitalocean_*` → digitalocean, …), or a Kubernetes `namespace/name` hint; a Kubernetes namespace the repo's manifests declare (not `default`) |
| proof | tags / labels on digitalocean, aws, gcp, azure, hetzner, kubernetes: `ruah-project` / `ruah:project` = a project name or its Ruah project id; `project` / `Project` / `app.kubernetes.io/part-of` = a project name (case and separators ignored; DigitalOcean string tags `project:<name>` too); `ruah:node` tags and manual element links (§6) |
| likely | host names the repo mentions — `.env.example` / `.env.sample` / `.env.template` / `*.example` env files, compose files, `netlify.toml`, `vercel.json` aliases, `CNAME`, `package.json` `homepage`, the App Platform spec, wrangler routes, IaC `settings.hosts` — equal to a resource's URL host / hosts, a CDN origin or bucket endpoint (`<bucket>.<region>[.cdn].digitaloceanspaces.com`, `<bucket>.s3[.<region>].amazonaws.com`, `<ref>.supabase.co`), or under a DNS zone resource; a generic workload name in the repo's manifests / IaC; a normalized IaC name; `supabase/config.toml` `project_id` equal to a project's name; a SAM stack prefix; a bare DigitalOcean tag equal to a project name |
| weak | the name looks like the project's — equal or containing after dropping case and separators (`harbor-pay-store` ~ `harborpaystore`), or sharing two meaningful words — against the repo folder, root `package.json` name, git `origin` repo name, the names its link files deploy under, the scope file `name` (and a system's name / repo ids); generic words (`api`, `web`, `admin`, …) never count; a name match to a plain code element (§6 linking) is weak too |

- **In scope = manual include + whole account + proof + likely − exclude.** Weak matches are
  **suggestions** ("Looks related"), never in scope on their own.
- Children follow their parent's strongest in-scope evidence ("part of <name>"): Vercel
  deployments → their project, Supabase functions / branches → their project, Fly volumes →
  their app. An excluded parent passes nothing on.
- Decisions: a name link to a code element (`api` ↔ `api`) and `project=` values on Vercel /
  Supabase / Railway / Fly / Netlify / Cloudflare (provider-internal parents, not user labels)
  are not proof — every client has an `api`. Link-file domains are proof for their own
  provider's DNS resource only; for everything else they are hosts (likely).
- Never read: `.env` and every other real env file, Terraform state / `*.tfvars`, anything
  under `.git` except `config` (the `origin` repo name; a worktree's `.git` file is followed to
  its common dir). Secret-typed App Platform env values are skipped. Bounds: directories ≤ 3
  levels deep (dependency / build output and dot-folders skipped; `.do`, `.vercel`, `.netlify`,
  `supabase/.temp` are read directly), ≤ 1,500 directories, ≤ 150 files, ≤ 256 KiB each, ≤ 500
  hosts. The daemon caches a repo's signals for 15 s.

### 14.3 Contract additions (all optional, additive)

```ts
interface CloudResource {           // §6.1 / §9.2 fields unchanged
  account?: string;                 // the account it was synced from, when a sync named one
  scope?: {                         // set on every read for an open project; never stored in the cache
    in: boolean;
    confidence?: "manual" | "proof" | "likely" | "weak"; // strongest evidence; absent = none
    reasons: string[];              // ≤ 6, strongest first; in a system prefixed "<repoId>: "
    excluded?: boolean;
  };
}
interface CloudScopeSummary {
  configured: boolean;              // some file lists accounts, includes or excludes
  accounts: (ScopeAccount & { repo?: string })[];
  files: { repo?: string; path: string; exists: boolean; error?: string }[];
  writable: boolean;                // false while the file edits go to is invalid
}
CloudSyncResult.scope?: CloudScopeSummary   // GET /api/cloud/resources, POST /api/cloud/sync
cloud.updated.scope?: CloudScopeSummary     // §9.4 push
```

Out-of-scope resources lose automatic element links (`linkedNodeId` from tags / names): only
the project's resources link to its map (a manual link is proof, so it stays unless excluded).
A viewer that gets resources without `scope` (an older daemon) treats them all as in scope.

### 14.4 Syncing only the project's accounts

When any scope file lists accounts, a project sync-all (`POST /api/cloud/sync` without
`providers`) and the watch loop cover only the listed providers, and each listed account is
synced on its own (`syncProviders({ accountLists })`: resources stamped with `account`,
per-account errors prefixed `<account>: `, a resource seen from two accounts listed once). A
sync-all also drops what unlisted providers left in the project's cache, so other clients' data
does not stay in it. Naming a provider still syncs it (its listed accounts, else its selected
account); an explicit `accounts` in the body wins. No accounts listed = the §9 behaviour for
syncing; the page and the CLI still show only the scope.

### 14.5 HTTP (same Origin rule as every POST: 403)

| Method + path | Body / result |
| --- | --- |
| `GET /api/cloud/scope` | `{ root, scope: CloudScopeSummary, evidence: { repo?, root, files, hosts, names, accountHints, truncated }[], resources: { id, provider, type, service, name, account?, scope }[] /* in scope, suggestions, excluded */, counts: { in, suggestions, excluded, total } }`; no project → 409 |
| `POST /api/cloud/scope/accounts` | `{ accounts: ScopeAccount[] }` (replaces the list; unknown provider → 400) → `CloudScopeSummary`; pushes `cloud.updated` |
| `POST /api/cloud/scope/resource` | `{ resourceId, action: "include" \| "exclude" \| "reset" }` (add / accept a suggestion, remove / dismiss, back to the evidence; unknown resource → 404, invalid file → 409) → `{ ok: true, scope }`; pushes `cloud.updated` |

### 14.6 Viewer (Cloud page; AppShell untouched)

- Header: a segmented control **This project (N)** / **All accounts (M)** (only when the daemon
  sends `scope`) and **Accounts (k)** (the account picker). In project mode the health strip, the
  Unhealthy filter, the provider filter and the counts use in-scope resources only.
- Each row: a reason badge (`from .do/app.yaml`, `tag project=…`, `in Terraform`, `added by you`,
  `looks related`, `removed`); the row menu offers **Add to project**, **Remove from project**
  and **Back to what the repo says**. The details drawer shows the account and every reason.
- **Looks related (K)**: suggestions with Add / Dismiss (dismiss = exclude).
- No proof and no accounts yet: the page asks which accounts the project lives in — a checkbox
  list per connected provider (its `IntegrationInfo.accounts`, or "Selected account"), each with
  a **whole account** switch (on by default there) — then saves and syncs. "Browse all accounts
  instead" switches to All accounts, where any resource is added from its row menu.
- "Show on map" and an element's "Runs on" section use in-scope resources only; the draw.io
  export (daemon and CLI) includes in-scope resources only.

### 14.7 CLI (`ruah app cloud`, no daemon)

| Command | Behaviour |
| --- | --- |
| `list \| status \| watch [--repo <path>] [--all]` | scoped to the repo (`--repo`, default: the nearest folder at or above the cwd holding `.git` or `ruah.system.json`; none → the whole account as before): only its accounts are read, only its resources shown (`list` adds a WHY column and a `Scope: <repo> — N of M resources · K look related` line); `status` exit codes count in-scope resources only. `--all`: the whole account (resources still carry `scope` when `--repo` is given). JSON: `list` adds `scope: { repo, …CloudScopeSummary, total }`, `status` adds `scope: { repo, inScope, total }`. |
| `scope [--repo] [--json] [--all]` | the files, accounts, what the repo says (files read, hosts), members with confidence and reasons, suggestions (with ids to add), removed ones; `--json`: `{ repo, scope, evidence, members, suggestions, excluded, counts, providers, errors }`. Reads the scope's accounts (`--all`: every connected account). |
| `scope add\|remove\|reset <id>…` | include / exclude / back to the evidence in `.ruah/cloud.json` |
| `scope accounts [list]`, `scope accounts add\|remove <provider> [<account>] [--whole]` | the account list |

Exit codes as §9.6; `scope` edits exit 1 on an invalid file (never overwritten) and 2 on usage
errors (unknown provider, not inside a repo without `--repo`).

## 15. Design tokens and palettes (2026-09-25)

The viewer's colours come from one module, `ui/src/design/tokens.ts` (the Ruah Design System
v1.0 values verbatim + the app's mapping; `docs/design/README.md`). No daemon API: this section
fixes the storage / DOM contract the shell's first-paint script shares with `lib/theme.ts`, the
preview scope, and the `ruah app design` CLI.

### 15.1 Palette and theme storage

| Key (`localStorage`) | Values | Default |
| --- | --- | --- |
| `ruah.theme` | `dark` · `light` · `contrast` · `system` | `dark` |
| `ruah.palette` | `teal` (**Teal + Indigo**) · `dusk` (**Indigo**, the design system's Dusk) · `sunrise` · `classic` (the design system's default, teal + lavender) | `teal` |
| `ruah.palette.v` | `2` once a palette was chosen (or the Dusk → Indigo note dismissed) since `dusk` became Indigo | absent |

`<html>` carries `data-theme="dark|light|contrast"` (always), `class="dark|light"` and
`data-palette="<id>"` for every palette except the default (absent = Teal + Indigo). Unknown stored
values fall back to the defaults. The first-paint script (`THEME_BOOT`, routes/__root.tsx) must set
`data-palette` for every id in `PALETTE_BOOT_IDS` (`dusk`, `sunrise`, `classic`), so every palette
is right from the first paint. A stored `dusk` now renders the
indigo palette (it was a lavender accent swap before); when `ruah.palette.v` is absent, Settings →
Appearance says so once. The viewer keeps the session's choice in memory: storage only persists it
(a choice holds when storage is unavailable) and other windows follow through the `storage` event.

### 15.2 Preview scope

Any element with `data-ruah-preview="<theme>:<palette>"` (e.g. `light:dusk`) re-declares every
token for its subtree, so a component renders exactly as the app would in that palette × theme.

### 15.3 Tokens

Generated into `ui/src/design/tokens.css` (`pnpm design:tokens`); the test suite fails while it
is stale. Semantic tokens as before (`--background` … `--primary`, `--ai`, `--ok`, `--warn`,
`--bad`, `--info`, `--node-*`, `--term-*`), plus: `--cat-1…6` (categorical; `--series-1…6` alias
them), `--agent-claude|cursor|grok|kiro|opencode` (agent identity tints), `--ph-*` (Phantom bodies
and props), `--ds-r-*` (the design system's radii). Tailwind colours: `cat-1…6`, `series-6`,
`agent-*`.

### 15.4 CLI (`ruah app design`, no daemon)

| Command | Behaviour |
| --- | --- |
| `palettes` | palettes with their six role colours, and the themes |
| `tokens [--palette <p>] [--theme <t>] [--json]` | every resolved token for one palette × theme (default `teal` × `dark`); JSON `{ palette, theme, tokens: Record<name, value> }` |
| `check [--palette <p>] [--theme <t>] [--json] [--all]` | WCAG 2.x contrast of every pair in `CONTRAST_PAIRS` — text ≥ 4.5:1 (7:1 in `contrast`), UI ≥ 3:1; JSON `{ pairs, checked, failed, results: { fg, bg, kind, tint?, palette, theme, ratio, min, pass }[] }` (failures only unless `--all`); exit 1 when a pair fails |
| `css [--out <file>] [--check <file>]` | the generated stylesheet to stdout or `--out`; `--check` exits 1 when `<file>` differs |

Usage errors (unknown palette / theme / command) exit 2.

## 16. Per-agent usage limits (2026-09-25)

Usage & limits for **every** coding agent, not only Claude: one reading per agent with its
plan, a meter per limit window with reset times, on-demand spend, what the agent's own CLI
recorded locally, and Ruah's own estimate. Code: `src/usage/limits/` (a standalone library:
one provider per agent, a caching service, the CLI's text rendering), used by the daemon
(`UsageService.agentLimitsService`, built by default — `run-serve.ts` is unchanged) and by
`ruah app usage limits` (no daemon). Nothing is invented: a source that cannot be read says
why (`reason`) and what to do (`action`). §2.3 `GET /api/usage/limits` is unchanged.

### 16.1 Types (`src/contracts/agent-limits.ts`; viewer copy in `ui/src/components/usage/agentLimitsModel.ts`)

```ts
interface AgentLimitsReport { checkedAt: string; agents: AgentLimits[] }   // signed-in agents first

interface AgentLimits {
  agentId: "claude" | "cursor" | "kiro" | "grok" | "opencode";           // claude-acp reads as claude
  name: string;
  installed: boolean;
  loggedIn: boolean | null;              // null: unknown / not applicable (OpenCode)
  plan: string | null;                   // "Max", "Pro+", "Kiro Pro"
  status: "ok" | "partial" | "not_installed" | "not_logged_in" | "unsupported" | "error";
  reason?: string;                       // set for every status but ok (and for a stale ok)
  action?: string;                       // "Run `kiro-cli login`." — backticks mark commands
  meters: LimitMeter[];
  onDemand?: { enabled: boolean; used: number | null; limit: number | null; currency: string;
               scope?: "personal" | "team"; note?: string };            // major units (dollars)
  local?: LocalUsage;                    // the agent CLI's own records (grok usage, opencode stats)
  estimate?: UsageEstimate;              // Ruah's usage.jsonl, labelled "estimate"
  source: string;                        // where the numbers came from (card footer)
  checkedAt: string;
  stale?: boolean;                       // last good reading; the refresh failed (see reason)
  dashboardUrl?: string;
}

interface LimitMeter {
  id: string;                            // five_hour, seven_day, seven_day_<model>, included, auto, api, credits, bonus:<code>, trial
  label: string;
  kind: "session" | "weekly" | "monthly" | "credits" | "other";
  usedPercent: number | null;            // 0–100 (2 decimals); null = no limit to measure against
  used?: number | null; limit?: number | null; unit?: "usd" | "credits" | "requests" | "tokens";
  resetsAt: string | null;               // ISO reset (or expiry, when detail starts with "Expires")
  periodStart?: string | null;           // ISO window start: drives the even-pace mark
  detail?: string;                       // "Unlimited", "Expires instead of resetting", …
}

interface LocalUsage { source: string; since: string | null; sessions?: number; inputTokens; outputTokens;
  cacheReadTokens; cacheWriteTokens; costUsd: number | null; approximate: boolean; byModel: ModelUsage[] }
interface UsageEstimate { label: "estimate"; since: string; until: string;
  basis: string;                         // "this weekly window" | "this billing period" | "last 30 days"
  turns; inputTokens; outputTokens; cacheReadTokens; cacheWriteTokens;
  costUsd: number | null;                // sum of agent-reported costs
  costedTurns: number; byModel: ModelUsage[] }
interface ModelUsage { model: string; turns?: number; inputTokens; outputTokens; cacheReadTokens?; cacheWriteTokens?; costUsd: number | null }
```

### 16.2 Sources (read-only; no model requests; tokens never logged or persisted)

| Agent | Plan / sign-in | Meters | On-demand | Local |
| --- | --- | --- | --- | --- |
| Claude Code | `get_usage` `subscription_type`; when it reports no windows, the CLI's account info (`initialize` / `accountInfo`: `apiProvider`, `tokenSource`, `apiKeySource` only — never the email) tells the cases apart: `tokenSource`/`apiKeySource` `"none"` = **not signed in** (`not_logged_in`, `/login`), an `apiKeySource` = API key (`unsupported`, plan "API key"), `apiProvider` ≠ `firstParty` = Bedrock / Vertex / Foundry / gateway (`unsupported`, `loggedIn: null`), no account info = `unsupported` with `loggedIn: null`, `plan: null` and a neutral reason. `installed` comes from the daemon's agent catalog | `five_hour` (Session · 5h), `seven_day`, model-scoped weekly — the §2.3 windows (live query ≤ 60 s, else probe ≤ 5 min, plus streamed `rate_limit_event`s; a streamed reset within a minute of the probed one keeps the probed value); `periodStart` = reset − window length | `rate_limits.extra_usage` (cents → dollars) | — |
| Cursor | `cursor-agent about --format json` (tier; no email = not signed in) | `GET https://cursor.com/api/usage-summary` with the **Cursor app's** login (`state.vscdb` `cursorAuth/accessToken`, read with `sqlite3 -readonly`; cookie `WorkosCursorSessionToken=<userId>::<jwt>`): `included` (total %, $ used of $ limit), `auto` (Auto + Composer %), `api` (API models %), all resetting at `billingCycleEnd`. Read only when cursor-agent and the app name the same account: not read when `cursor-agent about` fails (status `error`, so the last good reading shows as stale), when either names no email or they differ (`partial`), or when the token is expired (JWT `exp`, checked locally). | `individualUsage.onDemand` (else `teamUsage.onDemand`), cents → dollars | — |
| Kiro CLI | `kiro-cli whoami --format json` (`{"account":null}` = signed out) | Kiro's own `/usage` over ACP: `kiro-cli acp` → `initialize` → `session/new` (cwd: a fresh private temp folder per read — `mkdtemp`, mode 0700 — removed afterwards; `mcpServers: []`, but Kiro still starts the user's **global** MCP servers from `~/.kiro/settings/mcp.json`, which ACP cannot turn off — the card's source line says so) → `_kiro.dev/commands/execute {sessionId, command:{command:"usage",args:{}}}`; parses the GetUsageLimits shape (`usageBreakdownList[].currentUsage(WithPrecision)/usageLimit(WithPrecision)/nextDateReset`, active `bonuses`/`freeTrialInfo` as expiring meters, `subscriptionInfo.subscriptionTitle`), else Kiro's text — only on a line naming credits, only "Credits: 42.5 of 50" / "42.5 of 50 credits" / "85% used" (never another "n of m", "n/m" or a date) — else shows Kiro's message (`partial`). `success: false` is an `error` with Kiro's message, never parsed | `overageConfiguration.overageStatus` + `overageCharges` / `overageCap` | — |
| Grok Build | `grok models` ("You are logged in with grok.com.") | none: the allowance is only in grok's TUI (`/usage`) — status `partial` with that reason | — | `grok usage <id>` for sessions touched in 30 days (ids from `$GROK_HOME/sessions/<cwd>/<id>/` names + mtimes; fallback `grok sessions list`), turns filtered by `endedAt`, cost = `costUsdTicks / 1e10` |
| OpenCode | — | none: status `unsupported` (bills through connected providers) | — | `opencode stats --days 30 --models` (rounded: `approximate: true`) |

Caching (service): Cursor 5 min, Kiro / Grok / OpenCode 10 min, Claude per §2.3's own throttle;
`refresh` bypasses the cache but not a 15 s floor; a provider read is capped at 60 s (then
`error`): the read is aborted (its CLIs get the abort signal and are killed), no new read of that
agent starts until it has wound down, the timeout error is reused for 60 s only, and an answer
that still arrives replaces it; an `error` after a good reading returns the good one with
`stale: true`.
Estimates cover the agent's current period: the weekly window (Claude), the billing period
(Cursor, Kiro), else the last 30 days; installed agents with at least one turn only.

Environment: `RUAH_CLAUDE_USAGE_PROBE=0` (no Claude probe, as §2.3),
`RUAH_USAGE_READ_LOGINS=0` (do not read the Cursor app's login: Cursor shows its tier only),
`RUAH_CURSOR_STATE_DB` (another `state.vscdb`), `GROK_HOME`, and the `RUAH_*_BIN` overrides.

### 16.3 HTTP

| Method + path | Response | Notes |
| --- | --- | --- |
| `GET /api/usage/agents[?agent=<id>][&refresh=1]` | `AgentLimitsReport` (with `agent`: that agent only) | 400 unknown agent (`{ error }`), 405 other methods, 503 without usage tracking, 404 when the daemon's `UsageApi` has no `agentLimits` (older fakes). `claude-acp` is accepted for `claude`. |

Every `GET /api/usage/*` (these reads start agent CLIs and use saved logins) answers **403**
`{ error }` before doing anything when: the `Host` is not a loopback name, an IP literal or the
`--host` name (DNS rebinding); an `Origin` is present and not allowed (loopback origins +
`--allow-origin`, as for POSTs); or there is no `Origin` and `Sec-Fetch-Site: cross-site` (another
site's `<img>` / no-cors fetch). curl and other non-browser clients send neither and pass.

### 16.4 CLI (no daemon)

`ruah app usage limits [--agent <id>] [--json] [--refresh]` — the same report (`--json`: the
`AgentLimitsReport`), text: one block per agent with a bar per window, "resets in 3d 4h (Mon
9:00 AM)", on-demand, local stats, Ruah estimate, source. Exit 0; 2 on usage errors and unknown
agents; 1 when `--agent` names an agent whose reading is `error`. `ruah app usage help`. Subcommand
names win over folders of the same name (`ruah app usage` runs this even beside a `usage/`
folder; open such a folder with `ruah app open usage` or `ruah app ./usage`).

### 16.5 Viewer (self-contained, `ui/src/components/usage/`)

- `AgentLimitsPanel` — cards (signed-in first), a bell popover with the warning / critical
  thresholds (default 80 / 95 %, `localStorage` `ruah.usage.limit-settings.v1`) and a
  "Toast when crossed" switch (default on), refresh-all. Used by Usage → Limits and `/limits`
  (`AgentLimitsPage`); mountable in any panel slot.
- `AgentLimitCard` — plan pill, status pill, a meter per window (amber / red past the
  thresholds, a tick at the even-pace point, reset countdown with the absolute time on hover),
  on-demand, "Recorded locally", "Ruah estimate" (plus the viewer's model-price overrides for
  turns without a reported cost; "(1/2 turns)" when the cost covers only some turns), reason +
  action, source · checked · refresh · Dashboard ↗.
- `AgentLimitHint agentId` — "62% left · resets 4h" for the tightest window (tie → shorter
  window), for the top-bar agent pill; renders nothing without a percentage.
- `AgentLimitToasts` — one toast per agent, window, level and reset (the reset rounded to the
  minute, so two sources a second apart are one window; remembered in `localStorage`
  `ruah.usage.limit-announced.v1`); the panel mounts it, the shell may instead. It fetches
  nothing: it announces what the panel and the hints read.
- One shared reading (`agentLimitsStore.ts`), fetched per mounted scope: the panel reads every
  agent, a hint only its own (`?agent=<id>`), so a lone top-bar hint never keeps every
  installed agent's CLIs running. Fetched when the daemon origin appears, polled every 3 min
  while mounted and visible, refreshed per agent or all; an older daemon (404 / HTML) shows
  "Limits need a newer daemon".

## 17. Agent extensions: skills, MCP servers, powers, plugins, rules (2026-09-25)

One place to give every agent Ruah runs (Claude Code over the Claude Agent SDK; Cursor Agent,
Grok Build, Kiro CLI and OpenCode over ACP) more tools and knowledge. An extension is added once,
from a local folder, a git repository or the curated catalog, and turned on **per agent**; Ruah
hands it to the agent **when a session starts** (Agent SDK options, ACP `session/new`
`mcpServers`, per-process plugin folders) instead of editing the agents' own configuration.
Writing into Claude Code / Cursor / Kiro themselves happens only through an explicit, per-action
"Also install into". Code: `src/extensions/` (standalone library + `ruah app ext` CLI, works
without the daemon), `src/contracts/extensions.ts`, the viewer's `/extensions` route.

### 17.1 Model and files

```ts
interface Extension {                        // zod: ExtensionSchema (src/contracts/extensions.ts)
  id: string;                                // /^[a-z0-9][a-z0-9._-]{0,62}$/, not "ruah"; also the MCP server name
  kind: "skill" | "mcp" | "power" | "plugin" | "rule";
  name: string;
  description?: string;
  source:
    | { type: "local"; path: string }        // absolute; in a project file relative to the repo root (a folder outside the repo is refused for project scope, 422: the committed file would carry this machine's path)
    | { type: "git"; url: string; ref?: string; subdir?: string }   // clone: $RUAH_HOME/extensions/src/<slug>-<sha1(url#ref)[0:8]>
    | { type: "featured"; id: string }       // catalog entry; runs/env/notes copied at add time
    | { type: "inline" };                    // an MCP server defined by `runs` only
  enabledFor: string[];                      // agent ids: claude | cursor | grok | kiro | opencode (claude-acp uses claude's)
  runs?:                                     // kind "mcp" (inline / featured)
    | { type: "stdio"; command: string; args: string[] }   // no shell; `${project}` / `${home}` expanded at session start
    | { type: "http" | "sse"; url: string; headers?: string[] }  // https (http only on loopback); header NAMES
  env?: string[];                            // env var NAMES (values: Keychain, else the daemon's environment)
  notes?: string; homepage?: string;
  addedAt: string;
  // No install records here: a committed file must not be able to tell Remove what to delete
  // (an `installedInto` key from an older file is dropped when read).
}

interface InstallRecord {                    // $RUAH_HOME/extensions-installs.json only
  target: "claude-code" | "cursor" | "kiro"; scope: "global" | "project";
  path: string;                              // absolute; must be one of the files / folders install-into writes
  type: "json-key" | "copy" | "claude-cli";
  key?: ["mcpServers", string];              // json-key, claude-cli
  sha256?: string;                           // what Ruah wrote: the entry (stable JSON) or the copied file
  at: string;
}
```

| File | Content |
| --- | --- |
| `$RUAH_HOME/extensions.json` | `{ version: 1, extensions: Extension[] }` — global (this machine), mode 0600 |
| `<repo>/.ruah/extensions.json` | same shape — the project's, committable: sorted by id, pretty, no secrets, no file written for an untouched project |
| `$RUAH_HOME/extensions-trust.json` | `{ version: 1, approved: { "<scopeKey>/<id>": fingerprint } }` — scopeKey = `global` or the project id (§5.1) |
| `$RUAH_HOME/extensions-installs.json` | `{ version: 1, installs: { "<scopeKey>/<id>": InstallRecord[] } }` — "Also install into" writes made from this machine (mode 0600) |
| `$RUAH_HOME/extensions/src/` | git clones (fetched, never executed) |
| `$RUAH_HOME/extensions/runtime/<agent>-<hash>/` | generated plugin `ruah-ext` (`.claude-plugin/plugin.json`, `.cursor-plugin/plugin.json`, `skills/<name>` → symlinks); content-addressed, touched whenever a session reuses it, pruned by a session start after 7 days unused (never by a preview) |

- An unreadable file (bad JSON, schema error, > 1 MiB) is reported (`errors[]`) and never
  overwritten; writes answer 409 until it is fixed. Duplicate ids: the first wins.
- A folder is recognised by its layout (read only, ≤ 256 KiB per file): `SKILL.md` → skill;
  `POWER.md` (+ `mcp.json`, `steering/*.md`) → power; `.claude-plugin/plugin.json` or
  `.cursor-plugin/plugin.json` (or a `skills/*/SKILL.md` folder) → plugin; `.mcp.json` /
  `mcp.json` → mcp; `.md` / `.mdc` files → rule.
- What a plugin runs is read the way Claude Code's loader reads it, for every manifest present:
  `hooks/hooks.json` always, plus manifest `hooks` as a path, an inline `{ Event: [...] }` object
  or a list of those; `.mcp.json` always (`{ mcpServers }` or a bare table), merged with manifest
  `mcpServers` as a path, an object or a list (later names win); LSP servers (`.lsp.json`,
  `lspServers`), monitors (`(experimental.)monitors`, `monitors/monitors.json`) and the subagent
  status line (`settings.json` / `settings`). They are listed in `what.hooks` ("LSP server …",
  "Monitor …", "Subagent status line: …"). A form Ruah cannot read — an unknown type, a file
  outside the folder, unparsable JSON, an `.mcpb` bundle, a server with no command / URL, a hook
  with no command — makes the extension `invalid` (fail closed), never "runs nothing".
- Remote servers read from a folder get the same URL rule as inline ones (else `invalid`).
- A folder whose `.ruah` is `$RUAH_HOME` (e.g. `$HOME` with the default `~/.ruah`) is never a
  project: its `extensions.json` is the global file (project calls there → 409).
- Secrets: macOS Keychain, service `ruah`, account `ext:<scopeKey>:<id>:<NAME>` (§6 Keychain
  helper). Nothing else stores a value.

### 17.2 What each agent gets

| Kind | Claude (Agent SDK) | Cursor (ACP) | Grok (ACP) | Kiro (ACP) | OpenCode (ACP) |
| --- | --- | --- | --- | --- | --- |
| mcp | `options.mcpServers` | `session/new` `mcpServers` | same | same | same |
| skill | skill of the generated `ruah-ext` plugin (`options.plugins`; invoked as `ruah-ext:<name>`) | `cursor-agent --plugin-dir <dir> acp` | `grok agent --plugin-dir <dir> stdio` | install only (`.kiro/skills`) | `OPENCODE_CONFIG_CONTENT` `skills.paths` |
| power | its MCP servers + POWER.md as a skill | same | same | its MCP servers; POWER.md via install | same as Claude |
| plugin | `options.plugins` (skills, commands, agents, hooks, MCP) | `--plugin-dir` | `--plugin-dir` | its MCP servers only | its MCP servers + skills |
| rule | appended to the system prompt (≤ 64 KiB) | install only (`.cursor/rules/<id>.mdc`) | none (AGENTS.md / CLAUDE.md) | install only (`.kiro/steering`) | `OPENCODE_CONFIG_CONTENT` `instructions` |

- Remote (http / sse) servers go to an ACP agent only when its `initialize` advertises
  `agentCapabilities.mcpCapabilities.http` / `.sse`; otherwise they are skipped with a note.
- ACP stdio servers get an absolute `command` (PATH + Homebrew lookup, as ACP requires).
- Project entries win over global ones with the same id. Server names are unique per session;
  `ruah` stays the map tools' server (§1.7).
- A plugin whose MCP servers need secrets (env names without a literal value): Claude gets it
  with `skipMcpDiscovery: true` and Ruah starts its servers itself (`<id>-<server>`, through the
  launcher, `${CLAUDE_PLUGIN_ROOT}` expanded), so Keychain values reach them. Cursor and Grok load
  the plugin folder themselves: those servers read the values from the agent's own environment
  (said in the card's per-agent note and the session notes).
- `OPENCODE_CONFIG_CONTENT` is merged with an existing value of the daemon's environment.

### 17.3 HTTP (`/api/extensions`)

A POST can make every future session run a command, so it is accepted only from the viewer the
daemon serves, on this machine: loopback peer and loopback `Host` (403; DNS rebinding, network
peers of a `--host 0.0.0.0` daemon), `Content-Type: application/json` (415; a cross-site
text/plain "simple" POST needs no preflight, JSON does and the daemon grants none),
`Sec-Fetch-Site` same-origin / none when sent, and `Origin`, when sent, equal to the Host's own
origin and allowed by the `/ws` rule (403 — so neither another localhost port nor an
`--allow-origin` site can change extensions). The CLI does not use HTTP. Bodies: JSON ≤ 64 KiB,
zod-validated (a larger one is answered 413, `Connection: close`); errors `{ error }` never echo
received values. Project-scoped calls use the daemon's open project (409 without one).

| Endpoint | Body / query → answer |
| --- | --- |
| `GET /api/extensions` | → `{ project, agents: {id,name,installed}[], installed: ExtensionView[], errors, keychain }` |
| `GET /api/extensions/featured` | → `{ featured: FeaturedExtension[] }` (`added` set) |
| `GET /api/extensions/discover[?agent=a,b]` | → `{ agents: AgentDiscovery[] }` — read-only, names / commands / URLs / env NAMES; secret-looking args masked |
| `GET /api/extensions/preview?agent=<id>` | → `SessionPreview` — what a session of that agent receives now |
| `POST /api/extensions/add` | `{ scope, source, id?, name?, kind?, enableFor? }` (`source.inline = { runs, env? }`; local paths absolute) → `{ extension }`; nothing runs (git: clone only). `enableFor` is approved at once only when the request spells out what runs (inline, featured) or it runs nothing; a folder / clone that runs commands stays `review` until enabled with its fingerprint. A `builtin` featured entry → 422 |
| `POST /api/extensions/enable` | `{ id, scope, agents[], fingerprint? }` → `{ extension }`; records the approval; 409 when `fingerprint` (the one the user reviewed) is not the current one; 422 for an agent that cannot use the kind |
| `POST /api/extensions/disable` | `{ id, scope, agents? }` (absent = all) → `{ extension }` |
| `POST /api/extensions/remove` | `{ id, scope, uninstall? }` → `{ ok, notes }` — undoes this machine's install records, deletes its Keychain items and approval, removes an unused clone |
| `POST /api/extensions/fetch` | `{ id, scope }` → `{ extension }` — clones a git source missing on this machine |
| `POST /api/extensions/secret` | `{ id, scope, name, value }` → `{ ok: true }` (name must be declared; value → Keychain only) |
| `POST /api/extensions/secret/delete` | `{ id, scope, name }` → `{ ok, deleted }` |
| `POST /api/extensions/install-into` | `{ id, scope, target: "claude-code"\|"cursor"\|"kiro", targetScope }` → `{ extension, written[], notes[] }`; 409 while it is in review |

`ExtensionView` = `Extension` + `{ scope, path?, status: "ready"|"missing"|"review"|"invalid",
statusDetail?, what: { servers: ServerPreview[], hooks: string[], files: string[], launcher },
secrets: { name, set, fromEnv }[], support: Record<agent, { delivery: "session"|"install"|
"partial"|"none", note }>, fingerprint, installedInto?: InstallRecord[] }` (`what.hooks`: every
command a plugin runs besides its MCP servers; `installedInto`: this machine's records);
`ServerPreview = { name, transport, command?, args?, url?, env: string[], headers?: string[] }`.

### 17.4 Security rules

- **Nothing runs on add.** A git source is cloned `--depth 1 --single-branch
  --no-recurse-submodules` with `core.hooksPath=/dev/null`, `protocol.file|ext.allow=never`,
  `GIT_TERMINAL_PROMPT=0`, args array, URL after `--`; https / ssh / `git@host:path` only;
  `subdir` must stay inside the clone.
- **Explicit enable per agent, tied to what runs.** Enabling records a fingerprint (sha256 of
  kind, source, server definitions incl. bundled ones, env names, the hashed literal env / header
  values of bundled servers, plugin hooks / LSP servers / monitors / status line, and a digest of
  the runnable config files as read plus the content of the files their commands point to inside
  the extension folder, e.g. `${CLAUDE_PLUGIN_ROOT}/hooks/start.sh`, `server.js`). An extension
  whose fingerprint differs (edited folder or script, pulled commit, a teammate's project file) is
  `review`: shown with what it runs, **not injected** until approved again. A project file from
  the repo is never trusted until approved on this machine. Not covered: files outside the
  folder, and what a command downloads (`npx -y pkg@latest`).
- **What it runs is shown first** — command + args or URL, env var / header NAMES, hooks, files —
  on the card, in the add dialog and in the enable confirmation.
- **Secrets**: stdio servers that need values start through `ruah app ext exec --secrets
  <scopeKey>:<id> --env NAME… -- <command> <args…>`, which reads the Keychain in its own process
  and passes stdio through — values never appear in argv, config files, the agent's environment
  or logs. Header secrets of remote servers are the exception: they are in the MCP config given to
  the agent at session start (ACP: the `session/new` message; Claude SDK: its CLI's
  `--mcp-config` argument).
- **Other tools' configs** are written only by "Also install into", per extension and target:
  MCP entries merged into `.mcp.json` / `.cursor/mcp.json` / `.kiro/settings/mcp.json` (secrets as
  `${NAME}` / `${env:NAME}` references; an existing entry not added by Ruah → 409), Claude Code user
  scope through `claude mcp add-json -s user` (never `~/.claude.json` directly), skills copied with
  a `.ruah-installed.json` marker (links pointing outside the skill folder are not copied), rules
  written with a recorded sha256. The records live in `$RUAH_HOME/extensions-installs.json`, never
  in an extensions file. Remove undoes exactly those writes: only records of this machine, only at
  the paths / keys install-into writes, and only while the entry or file is still what Ruah wrote
  (Claude Code's user entry is compared, read-only, with `~/.claude.json` /
  `$CLAUDE_CONFIG_DIR/.claude.json` before `claude mcp remove`); anything else is left with a note.
- URLs: https (http only for loopback), no credentials in URLs (git: no user name in https URLs,
  use git's credential helper). Commands are one executable (no shell line).
  `RUAH_EXTENSIONS=0` turns injection and the endpoints off.

### 17.5 Session injection

`AgentCatalog` gets `extensions(agentId, root)`; bridges receive `BridgeOptions.extensions:
{ resolve(preset?) }` (src/acp/bridge.ts) and call it at every process start (ACP: before the
spawn — the returned `acp.preset` replaces the launch) and session open (Claude: every
`query()`; ACP: `session/new` and `session/load`). A failure resolves to "no extensions" plus a
note in the debug log; a changed switch applies to the next session. ACP plugin folders (Cursor /
Grok `--plugin-dir`) and env (`OPENCODE_CONFIG_CONTENT`) are fixed per process: when a new or
loaded session's resolution changes the launch, the bridge restarts the agent process first
(logged), otherwise the process is kept and only `mcpServers` change.

### 17.6 CLI (`ruah app ext`, no daemon)

`list | featured | discover [--agent] | show <id> | preview --agent <id>` (all `--json`),
`add <folder|git-url|featured:<id>> [--kind --id --name --ref --subdir]`,
`add --mcp <name> [--env NAME]… -- <command> [args…]`, `add --url <https://…> [--sse] [--header
NAME]…`, `enable|disable <id> [--agent <id>]…`, `remove <id> [--keep-installs]`, `fetch <id>`,
`secret set|delete <id> <NAME>` (value from stdin, hidden on a TTY), `install-into <id> --target
claude-code|cursor|kiro [--global]`; `--project` = the repo's file (`--repo <dir>`, default: the
git repo around the cwd, or a folder below `$HOME` with its own `.ruah/extensions.json`; `$HOME`
and Ruah's home are never a project, and outside a repo `--project` needs `--repo`). Exit 0 ok,
1 not found / failure, 2 usage.

### 17.7 Featured catalog (`src/extensions/featured.json`, metadata only)

Claude Design (`builtin: "claude"`: a Claude Code tool, not an MCP server Ruah injects — its
endpoint `https://api.anthropic.com/v1/design/mcp` answers 401 with RFC 9728 metadata naming
`https://claude.ai/v1/design/mcp` as the authorization server, whose metadata is not publicly
discoverable, and Claude Code calls it with its own claude.ai / `/design login` credential; the
card says how to turn it on and there is nothing to add), Filesystem, GitHub (Docker,
`GITHUB_PERSONAL_ACCESS_TOKEN`), Playwright, Chrome DevTools, Context7, Sentry, Linear, Figma,
Notion, Supabase, Terraform, AWS Documentation, Cloudflare Docs, Kubernetes (read-only), Memory,
Sequential Thinking, Fetch. Adding one copies its `runs` / `env` into the extension (what the
user approved is what runs).

## 18. Live preview of the project's dev server (2026-09-25)

The open project's dev server, run by Ruah and shown next to the agent, so the agent's edits
appear as they are saved. Code: `src/preview/*` (a standalone library: detection, the
remembered choice, URL discovery, probes, runners, a static server, the process manager, the
HTTP endpoints, the `ruah app preview` CLI; no daemon needed), types in
`src/contracts/preview.ts`, viewer `ui/src/lib/preview.ts` + `ui/src/components/preview/*`
(`<PreviewPane/>`, the `/preview` route). Nothing starts on its own: a dev server runs only
after an explicit start.

### 18.1 Types

```ts
type PreviewState = "stopped" | "starting" | "running" | "crashed";
type PreviewKind = "script" | "python" | "ruby" | "go" | "compose" | "deno" | "static" | "custom";

interface PreviewCandidate {
  id: string;           // "<dir>#<name>": ".#dev", "apps/web#dev", "api#django", ".#static"; "custom" = your command
  title: string;        // "Vite", "Next.js", "Django", "Static site", "Your command"
  command: string;      // as shown ("pnpm run dev"); "{port}" is filled in at start
  dir: string;          // repo-relative folder ("." = root; a system: "<repoId>/<rel>")
  framework: string;    // vite | next | remix | astro | sveltekit | nuxt | expo | storybook | cra | angular | … | django | flask | fastapi | streamlit | rails | jekyll | go | hugo | compose | deno | static | node | monorepo | custom
  kind: PreviewKind;
  port?: number;        // expected (default) port; what the server prints wins
  hmr: boolean;         // the server reloads the page itself (HMR, live reload)
  reason: string;       // "package.json scripts.dev: vite", "manage.py", "index.html"
  score: number;        // higher = better default
  workspace?: string;   // package name (monorepos)
  env?: Record<string, string>;   // extra environment ("{port}" filled in), e.g. PORT for Rails' bin/dev
  needs?: string;       // program it needs on PATH ("pnpm", "python3", "docker")
  available?: boolean;  // false: `needs` is not on PATH (shown with `install`; a start is still allowed)
  install?: string;     // how to get it
  setup?: string;       // dependencies look missing (no node_modules): "pnpm install" — shown, never run by Ruah
}

interface PreviewDetection {
  root: string;
  candidates: PreviewCandidate[];   // best first
  monorepo: boolean;                // candidates come from more than one folder
  packageManager?: "pnpm" | "yarn" | "npm" | "bun";
  selected: string | null;          // what a start without arguments runs; null = the user picks
  choice: PreviewFile | null;       // the saved choice
  configError?: string;             // .ruah/preview.json is invalid (never overwritten then)
  truncated: boolean;
}

interface PreviewStatus {
  projectId: string; root: string;
  rev: number;                  // grows with every push (starts at the daemon's clock; 0 = never started)
  state: PreviewState;
  candidate: PreviewCandidate | null;   // what runs / ran (your command as a "custom" candidate)
  command: string | null;       // after {port} substitution
  cwd: string | null;
  url: string | null; port: number | null;
  healthy: boolean;             // the URL answered HTTP at the last check
  framing: "ok" | "blocked" | "unknown"; // "blocked": X-Frame-Options DENY/SAMEORIGIN or CSP frame-ancestors without * / localhost
  hmr: boolean;
  runner: "pty" | "process" | "static" | null;
  terminalId: string | null;    // the "preview" tab (§7, TerminalInfo.kind = "preview") when runner = "pty"
  pid: number | null; startedAt: string | null;
  exitCode: number | null; signal: number | null;
  error?: string;               // one line: why it crashed / could not start
  logs: string[];               // last ≤ 40 output lines, ANSI stripped
}
```

`TerminalInfo` (§7.2) gains `kind?: "preview"` (additive): the tab runs the dev server, not a shell.

### 18.2 Detection (deterministic, no network, bounded)

Folders: the root, workspace globs (`pnpm-workspace.yaml`, package.json `workspaces`,
`lerna.json`), top-level folders and `apps|packages|services|sites|web|frontend|backend|client|
server|src/*` — only folders with a marker file, at most 150. A multi-repo system (§12) adds
each repo under `<repoId>/`. Per folder:

| Source | Candidate |
| --- | --- |
| package.json scripts `dev`, `develop`, `dev:web`, `start:web`, `web`, `start`, `serve`, `storybook` | `<pm> run <script>` (npm: extra args after `--`); pm = the nearest lockfile up to the root (pnpm-lock.yaml, bun.lock(b), yarn.lock, package-lock.json), else `packageManager`, else npm. The framework comes from the script (vite, next dev / start, nuxt, astro, remix, react-router, expo start, ng serve, storybook, react-scripts, webpack serve, parcel, gatsby, docusaurus, vitepress, eleventy, wrangler dev, nodemon / tsx watch …) and the dependencies (SvelteKit, TanStack Start, SolidStart … on Vite). Build watchers, test runners and linters (tsc, tsup, rollup, jest, vitest, eslint, `vite build`) are not servers. `turbo`/`nx`/`lerna run dev` is offered last ("every app"). Expo: `--web` is added when react-native-web is a dependency; native-only apps are skipped. |
| deno.json(c) tasks `dev`, `start` | `deno task <name>` |
| `manage.py` | `<py> manage.py runserver 127.0.0.1:{port}` (Django) |
| `X = FastAPI(` / `X = Flask(` / `create_app` / `import streamlit` in app.py, main.py, … | `<py> -m uvicorn <module>:X --reload --port {port}`, `<py> -m flask --app <module> run --debug --port {port}`, `<py> -m streamlit run <file> --server.port {port} --server.headless true`. `<py>`: `./.venv/bin/python` (or venv, env), else `uv run python` (uv.lock), `poetry run python`, `pipenv run python`, else `python3` |
| Gemfile with rails + bin/rails | `bin/dev` (env `PORT={port}`) when present, and `bin/rails server -p {port}`; Jekyll: `bundle exec jekyll serve --livereload --port {port}` |
| go.mod | `air` with `.air.toml` / `air.toml`; `go run .` with main.go |
| hugo.toml / hugo.yaml / hugo.json (or config.toml with baseURL + content/) | `hugo server --port {port}` |
| compose.yaml / docker-compose.yml | `docker compose up` (`--watch` with `develop:`); port = the first published host port, web / app / frontend services first |
| index.html without package.json (at the root also public/, docs/, site/, www/) | the built-in static server with live reload |

Selection: the saved choice wins (a saved command is the `custom` candidate); else the best
candidate when only one folder has any, or when it beats every other folder's best by ≥ 5;
else `selected: null` and the viewer / CLI asks.

### 18.3 `<repo>/.ruah/preview.json` (committable, no secrets)

```ts
interface PreviewFile {
  version: 1;
  candidate?: string;   // a candidate id
  command?: string;     // your own command ({port} allowed) — replaces `candidate`
  dir?: string;         // its folder (default ".")
  url?: string;         // fixed preview URL (default: what the server prints): http(s) on this
                        // computer only — localhost, *.localhost, 127.x.x.x, [::1], no credentials
}
```

The file comes with the repo, so `url` is never another scheme (`javascript:`, `file:`, `data:`)
or another machine: such a file is invalid (`configError`), and `POST /api/preview/choice`
answers 400.

Written only by an explicit choice (the command picker with "Remember", `ruah app preview
--pick|--command … --remember`), only when the content changes, pretty-printed with a stable
key order; an empty choice deletes the file. An invalid file is reported (`configError`) and
never overwritten: edits answer 409.

### 18.4 HTTP (409 without an open project)

| Method + path | Body / result |
| --- | --- |
| `GET /api/preview` | `PreviewStatus` of the open project (`state: "stopped"`, `rev: 0` when it never ran) |
| `GET /api/preview/detect` | `PreviewDetection` |
| `GET /api/preview/logs?lines=` | `{ lines }` — the last ≤ 500 output lines |
| `POST /api/preview/start` | `{ candidate? , command?, dir?, remember? }` → `PreviewStatus`. Nothing: the saved / selected candidate (409 `{ error, detection }` when the user must pick or nothing was found); the same command already running: its status; something else running: stopped first. Unknown candidate 404, folder outside the project 400. |
| `POST /api/preview/stop` | → `PreviewStatus` (Ctrl+C, 3 s — 12 s for `docker compose up`, which stops its containers first — hang up, 3 s; a crashed preview goes back to "stopped"; the "preview" tab is closed) |
| `POST /api/preview/restart` | → `PreviewStatus` (the same command, re-detected) |
| `POST /api/preview/choice` | `{ candidate?, command?, dir?, url? }` (null clears; `url` as in §18.3, else 400) → `PreviewDetection` |

POSTs: the `/ws` Origin rule (403); `Sec-Fetch-Site`, when sent, is `same-origin` or `none`
(403 — the previewed app on another localhost port passes the Origin rule but must not drive
its own server); a loopback peer (403 unless `--allow-remote-terminal`).
`command` (your own command, on start or choice) is a shell command, so it also needs the
terminal token (§7.1) in `x-ruah-token` (403 without); the saved command of `.ruah/preview.json`
runs without it (it is the repo's own, like its package.json scripts).

### 18.5 Push (`/ws`, every viewer)

`{ type: "preview", status: PreviewStatus }` on every state change and at most every 250 ms
while output arrives; filter by `status.projectId`. A viewer keeps the status with the highest
`rev` (an HTTP answer may arrive after a newer push) and replaces it unconditionally after a
(re)connect (a new daemon counts from its own clock). `ServerMessageSchema` includes it.

### 18.6 Runtime

- **Runner.** A PTY from the terminal manager (§7): `/bin/sh -c "<command>"` in a tab titled
  `preview · <title>` (`kind: "preview"`), output acknowledged at once so flow control never
  pauses the server; stop = Ctrl+C. Without node-pty (or when the PTY is refused): a child
  process in its own process group (SIGINT, SIGTERM, SIGKILL). A stop (also a restart, the idle
  stop and the daemon's exit) closes the tab; a crashed server's tab stays, with its output, until
  the next start or stop — so there is at most one preview tab per project. The static server
  runs in the daemon (127.0.0.1, paths confined to the folder, `no-store`, an EventSource script
  injected into HTML: CSS changes restyle, other changes reload). Any web page can reach it, so
  it answers 403 to a `Host` that is not a loopback name (localhost, *.localhost, 127.x, [::1] —
  DNS rebinding) and to any path with a segment starting with "." (`.env`, `.git/`, `.ssh/`,
  also through a symlink; `.well-known` is served); a 404 is logged with its path only for the
  page's own requests (`Sec-Fetch-Site: same-origin`: the log feeds "Ask agent to fix"), and
  error answers carry no details.
- **Environment.** The user's login + interactive shell environment, read once (`$SHELL -i -l -c
  env` without a TTY, 8 s timeout; `RUAH_PREVIEW_SHELL_ENV=0` uses the daemon's), so PATH
  from ~/.zshrc works when Ruah started from the Dock; the terminal's rules drop daemon
  plumbing (§7.4); `BROWSER=none`. `{port}` = the first free port at or above the candidate's
  (a connect test on 127.0.0.1 and ::1, then a bind).
- **URL.** The first local URL the server prints (ANSI stripped; "Local" beats "Network";
  0.0.0.0 / :: → localhost; remote hosts, debugger and HMR sockets ignored; "listening on port
  N" counts), else — after 2.5 s — the expected ports that were not open before the start are
  probed; `.ruah/preview.json` `url` overrides both (a line in the log after 30 s without an
  answer). **Running** = the URL answered HTTP (any status); checked every 400 ms while starting
  and every 5 s while running (`healthy`); https accepts self-signed certificates on loopback
  hosts only.
- **Crash.** An exit that was not asked for → `crashed` with `exitCode` / `signal`, the last
  lines, and `error` = the last error-looking line. Closing the preview tab in the terminal panel
  is a stop (`stopped`, a line in the log), not a crash.
- **Lifetime.** One server per project. It keeps running while you switch projects and is
  stopped once its project has not been open for `RUAH_PREVIEW_IDLE_MS` (default 10 min; 0 =
  at the next sweep, ≤ 2 s), and every server is stopped when the daemon exits (Ctrl+C, short
  grace; 12 s for `docker compose up`). `RUAH_PREVIEW=0` turns the feature off (endpoints 503).
- **Shell.** `registerPreview()` (`ui/src/components/preview/register.tsx`, called once by
  `ui/src/router.tsx`) registers the pane in the shell's preview slot (`shell/slots.ts`, loaded on first open): the top
  bar's Preview toggle opens it on the right, as "Agent | Preview" tabs or alone; the slot passes
  `onAskAgent`, which brings the agent (its tab, or the agent panel) to front. `/preview` shows
  the same pane as a page (its "Ask agent to fix" opens the agent panel beside it).
- **Viewer.** An iframe sandboxed without top navigation (`allow-scripts allow-same-origin
  allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock allow-presentation`,
  permissions clipboard-write + fullscreen only). `framing: "blocked"` → in the desktop app a
  `<webview>` (`window.ruah.previewWebview === true`, §5.4 addition): main.cjs enables
  `webviewTag` and locks every webview down (no preload, no Node, sandbox, contextIsolation,
  http(s) only, partition `persist:ruah-preview`, popups → the default browser); in a browser:
  "Open in browser". Frames and webviews get no camera / microphone / location / notification
  permissions. Without HMR the page reloads after each agent turn whose `activity`
  `turn.finished` event (§13.2) lists edited files (a per-project toggle, stored in the
  viewer). A crash offers "Ask agent to fix": the command, folder, exit and the last ≤ 60
  lines are drafted into the composer (`requestComposerDraft`), never sent.

### 18.7 CLI (`ruah app preview`, no daemon)

| Command | Behaviour |
| --- | --- |
| `ruah app preview [<repo>]` | runs the selected candidate in the foreground (output passed through, colours kept), prints `ruah ▸ preview at <url>` once it answers; Ctrl+C stops it. Exit 0 stopped by you, 1 crashed / nothing found, 2 a pick is needed or bad arguments. |
| `--detect` · `--json` | print the candidates (▸ = what would run) · the `PreviewDetection` as JSON; nothing runs |
| `--pick <id>` · `--command "<cmd>" [--dir <folder>]` | run that candidate · your own command; `--remember` saves it in `.ruah/preview.json` |
| `--open` | open the URL in the default browser once it answers |

### 18.8 Developing Ruah itself (`pnpm dev`)

`scripts/dev.ts`: the daemon under `tsx watch` (restarts on `src/` changes), the viewer on the
Vite dev server with HMR (proxying `/api` and `/ws*` to the daemon when `RUAH_DEV_DAEMON_URL`
is set, ui/vite.config.ts), and Electron with `RUAH_VIEWER_URL` (load the viewer from that URL)
and `RUAH_DAEMON_URL` (attach to that daemon, start none) — both electron/main.cjs additions,
unset in normal runs. The viewer reconnects after a daemon restart; in dev builds
(`import.meta.env.DEV`) it re-opens the project it had open.
---

## 19. Desktop app packaging (macOS) (2026-09-25)

`pnpm dist` turns the Electron shell into `Ruah.app` (bundle id `dev.ruah.app`) and
`release/Ruah-<version>-arm64.dmg`, good enough to be the daily driver: no system Node,
the login shell's environment, one instance that takes folders from `open -a`, `ruah app`
and the Dock. Code: `electron/main.cjs` (wiring), `electron/app-shell.cjs` (decisions,
unit-tested), `src/desktop/` (login environment, `ruah app doctor`, launch planning, child
environments), `electron-builder.config.cjs` + `scripts/macos/` (build).

### 19.1 Bundle layout and runtime

| Path in `Ruah.app/Contents` | What |
| --- | --- |
| `MacOS/Ruah` | Electron main process (`electron/main.cjs`) **and** the daemon: main spawns it with `ELECTRON_RUN_AS_NODE=1` as `--disable-sigusr1 Resources/app/dist/cli.js serve …` (`RUAH_NODE` overrides the binary, then without the flag) |
| `Resources/app/` | `package.json`, `electron/`, `dist/`, `viewer/`, production `node_modules/` — no asar (the daemon spawns binaries from `node_modules`) |
| `Resources/app/node_modules/node-pty/prebuilds/darwin-arm64/` | N-API addon (ABI-stable across Node and Electron, no rebuild) + `spawn-helper` (made executable at build time) |
| `Resources/app/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` | Claude's native CLI, still signed by Anthropic (excluded from re-signing) |
| `Resources/bin/ruah-app` | `ruah app …` on the app's runtime (`ELECTRON_RUN_AS_NODE=1 MacOS/Ruah Resources/app/dist/cli.js "$@"`; symlinks resolved) |
| `Resources/THIRD_PARTY_NOTICES.md` | the repository's `THIRD_PARTY_NOTICES.md`: the copyright and license notices of the code bundled into `dist/` and `viewer/` (T3 Code, shadcn/ui: MIT) and of the fonts (OFL 1.1), whose source headers the bundlers drop; `Resources/LICENSE` too once the repository has a `LICENSE` (added 2026-09-26) |

`Info.plist`: `CFBundleDocumentTypes` = one `public.folder` type, role Viewer,
`LSHandlerRank: Alternate` (Ruah can open folders; it never becomes their default app);
`NS*FolderUsageDescription` strings for Documents, Desktop, Downloads, removable and
network volumes. Camera, microphone, audio-capture and Bluetooth strings replace
Electron's generic ones: Ruah never uses them, but macOS attributes requests from its
children (agents, the integrated terminal) to Ruah and stops a process whose app has no
string, so they say "Programs you run in Ruah's terminal or through its coding agents may
ask … Ruah itself never does."

Fuses (`electronFuses`): `RunAsNode` **on** (the daemon, the MCP server and the
claude-agent-acp adapter are this binary as Node); `EnableNodeOptionsEnvironmentVariable`
(`NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`), `EnableNodeCliInspectArguments` (`--inspect`,
SIGUSR1 — for the main process only: a process running as Node still takes them, so main
starts the daemon with `--disable-sigusr1`, which its self-spawned children inherit through
`execArgv`) and `GrantFileProtocolExtraPrivileges` **off**; the rest Electron's defaults (no
asar). The daemon makes no outbound TLS connections of its own, so `NODE_EXTRA_CA_CERTS`
not reaching it changes nothing; agents and CLIs still read it from their environment. Trade-off: with RunAsNode any local process can run its own JS as Ruah
(`open --env ELECTRON_RUN_AS_NODE=1 -a Ruah --args -e …`) and inherit the folder access
granted to Ruah — for a Developer ID build across versions. Removing it needs the daemon
on a separate helper runtime (a bundled Node or a helper app that asks for no folder
access); README "Security" says so.

Child environments (`src/desktop/child-env.ts`): `ELECTRON_RUN_AS_NODE`,
`ELECTRON_NO_ATTACH_CONSOLE`, `RUAH_PARENT_PID` and `RUAH_LOGIN_ENV` are the daemon's
only — agents (ACP processes, the Claude Agent SDK child), the integrations' CLIs and the
terminal (§7) never get them, so an Electron-based CLI an agent runs (`code`, `cursor`)
is not turned into Node. Children on the daemon's own binary set
`ELECTRON_RUN_AS_NODE=1` explicitly (only under Electron): the `ruah app mcp` server
(map tools), the `claude-acp` preset, a `RUAH_WORKSPACE` engine.

Flavors (`scripts/macos/flavor.cjs`): `RUAH_APP_FLAVOR=<name>` (`[a-z][a-z0-9-]{0,23}`)
builds a side-by-side app — product `Ruah <Name>` (`Ruah Test.app`), bundle id
`dev.ruah.app.<name>`, artifacts `Ruah-<name>-<version>-arm64.*`, `ruahFlavor` in the
packaged `package.json` (main.cjs names the app, profile and logs after it). macOS routes
`open -a`, Finder and the Dock by bundle id, so only a separate id keeps a test build and
the installed app from receiving each other's folders. `Resources/bin/ruah-app` finds the
binary through `CFBundleExecutable`.

### 19.2 Login-shell environment (daemon)

An app started by Finder, the Dock or `open` gets launchd's environment: `PATH`
`/usr/bin:/bin:/usr/sbin:/sbin` and none of what the user's shell profile exports
(`ANTHROPIC_API_KEY`, `CLAUDE_CODE_USE_BEDROCK`, `AWS_PROFILE`, `KUBECONFIG`,
`HCLOUD_TOKEN`, proxies, `LANG`, …). main.cjs starts the daemon with `RUAH_LOGIN_ENV=1`;
`ruah app serve` then (before any agent or CLI starts, removing the variable):

1. runs the login shell — `$SHELL` if absolute and executable, else `/bin/zsh` — as
   `-i -l -c "printf '%s' __RUAH_LOGIN_ENV__; /usr/bin/env -0 || /usr/bin/env; printf '%s' __RUAH_LOGIN_ENV__"`
   (fish: `-l -i -c`; csh/tcsh: `-c` only), stdin closed, its own process group, killed
   after 5 s; daemon plumbing (§19.1 child environments, plus `RUAH_MCP_TOKEN`) removed from
   its environment, `DISABLE_AUTO_UPDATE=true` added. Output outside the markers (banners)
   is ignored; between them, NUL-separated `NAME=value` entries (values may hold newlines;
   names `[A-Za-z_][A-Za-z0-9_]*`; an `env` without `-0` prints lines, read with a line that
   does not start with `NAME=` continuing the previous value). It must include a `PATH`
   with absolute entries.
2. `PATH`: for launchd's bare `PATH`, the login `PATH` first, then what only the process
   had; for a `PATH` that already looks like a terminal's (`pnpm app`, `ruah app` with
   `RUAH_APP_DEV=1`), the process's order is kept and only the login shell's missing
   entries are appended (an active venv, `nvm use`, a project `bin` stay first). Always
   deduplicated, trailing `/` and relative entries dropped.
3. every other variable the process does **not** have is added — never overwritten, and
   never `PATH`, `PWD`, `OLDPWD`, `SHLVL`, `_`, `TERM`, `DISABLE_AUTO_UPDATE`, the plumbing,
   `RUAH_HOME`, `RUAH_USER_DATA`, `RUAH_PORT` or `RUAH_DAEMON_URL`. The log line names only
   the count (`environment from the zsh login shell (<ms> ms): PATH + <n> variables`).
4. caches the login `PATH` only in `$RUAH_HOME/cache/login-path.json`:
   `{ version: 1, shell: string, path: string, resolvedAt: string }` (per shell). The other
   variables are never written to disk (they may be secrets).

Timing: with launchd's bare `PATH` the daemon **waits** for the shell (≤ 5 s) on every
launch — agents read their environment when they start (the Claude SDK bridge takes a
copy), so it must be complete first; if the shell fails, the cached `PATH` applies (logged;
no other variables). With a terminal's `PATH` the process already has the user's
environment: the shell only fills gaps, in the background. A failing shell leaves the
environment unchanged (logged). The integrated terminal is unaffected (it runs `$SHELL -l`
itself, §7).

### 19.3 One instance, opening folders

- Single-instance lock per profile (§19.5). A second launch passes
  `additionalData = { folder: string | null }` (the folder its own command line asked
  for) and quits; the running app opens that folder, or just comes to the front.
  Without `additionalData` the second instance's argv is parsed (switches ignored; dev:
  after the app path, packaged: after the binary; relative to its cwd).
- `open -a Ruah <folder>`, a folder dropped on the Dock icon, Finder "Open With": the
  `open-file` event (registered before `ready`; at launch the folder becomes the daemon's
  startup repo). A file opens its folder. macOS delivers these to whichever running app
  has the bundle id, whatever its `RUAH_HOME`: an instance started with `RUAH_HOME` asks
  **Open <name> in this Ruah?** (Open / Cancel, default Cancel) before opening a folder
  that arrives this way after its first window (its own launch folder is trusted). A copy
  meant to run next to the installed app is a flavored build (§19.1).
- Opening = `POST /api/projects/open { path }` (§5.3) from main to its daemon (no
  `Origin`, so the origin check passes), then the window comes up; the viewer follows
  through the `project` broadcast. Requests that arrive while the daemon starts are
  queued; the last one wins. A non-200 answer shows a dialog with the daemon's `error`.
- **File → Open Folder…** (native picker) does the same. Its ⌘O is displayed but not
  registered: the viewer's own ⌘O handler keeps working.
- `ruah app [<folder>]` (`src/desktop/launch.ts`): on macOS the bundle is the one the CLI
  itself runs from (`…/X.app/Contents/Resources/app`), else an installed app —
  `$RUAH_APP_BUNDLE` (only if it exists), `/Applications/Ruah.app`,
  `~/Applications/Ruah.app`, first found. It runs
  `open -a <bundle> [--env RUAH_HOME=…] [--env RUAH_AGENT=…] [--env RUAH_PORT=…] [<folder>]`
  (env only applies when this starts the app) and **waits** for `open`: exit 0 prints
  `Opened Ruah [on <folder>] (<bundle>)`; a non-zero exit (a Gatekeeper-blocked app, a
  damaged bundle) prints `ruah app: could not open <bundle>: <open's stderr>` and exits 1.
  Otherwise, or with `RUAH_APP_DEV=1`, it starts this checkout's Electron detached
  (`electron <root> [<folder>]`), which hands off to that checkout's running dev instance
  through the lock (§19.5).

### 19.4 Desktop bridge additions (§5.4)

- `window.ruah.version`: the app's `package.json` version (main passes
  `--ruah-version=<v>` in `additionalArguments`; `pnpm desktop` also has
  `npm_package_version`).
- `window.ruah.onMenuCommand(callback: (command: string) => void): () => void` —
  application-menu commands main forwards on IPC channel `ruah:menu-command`
  (`{ command }`). Today: `"settings"` (**Ruah → Settings…**, ⌘,). With no subscriber the
  preload handles `"settings"` itself: `history.pushState` to `/settings` plus a
  `popstate` event (the router follows). A subscriber replaces that default.

### 19.5 Window, lifecycle, profile and logs

- Window: 1440×900 shrunk to 90 % of the primary work area and centred on first launch,
  minimum 960×600; position, size and maximized state saved in
  `<userData>/window-state.json` and restored while they still fit a display. Title
  "Ruah". Shown on `ready-to-show`.
- macOS: closing the window **hides** it (the viewer stays connected, so background turns
  keep running per §2.2 rule 6 and notifications still fire); Dock click / `activate`,
  a notification click, `open -a` or a second launch show it again. ⌘Q (or SIGTERM)
  quits and stops the daemon.
- Daemon exit after it was healthy → one dialog at a time: **Restart** (daemon on the
  start screen, viewer reloaded, folders that arrived meanwhile opened) / **Later** (Esc;
  the backend stays down — a Dock click or an arriving folder asks again) / **Show Logs**
  / **Quit**. A restart that dies before it is healthy returns to the same dialog ("It
  could not be restarted (…)"), never a second one. A crashed viewer process reloads.
- `target=_blank` links and `window.open` never open an app window: `http(s)` URLs — the
  daemon's own included — open in the default browser; anything else is refused. A
  navigation of the window itself stays in the window only on the daemon's origin.
- Menu: Ruah (About, Settings…, Services, Hide, Hide Others, Show All, Quit), File (Open
  Folder…, Close Window), Edit (standard roles), View (Reload ⌘R, Force Reload ⇧⌘R,
  Toggle Developer Tools ⌥⌘I **only in dev** or with `RUAH_DEVTOOLS=1`, zoom items shown
  without registered shortcuts — the terminal owns ⌘= / ⌘- / ⌘0 — and Full Screen),
  Window, Help (Ruah on GitHub, Show Logs in Finder). Packaged builds disable DevTools
  in `webPreferences` too.
- Profile (`userData`, which also holds the single-instance lock): `RUAH_USER_DATA`, else
  `$RUAH_HOME/desktop` when `RUAH_HOME` is set (its own profile, lock and logs — folders
  from macOS still arrive by bundle id, §19.3), else
  `~/Library/Application Support/<profile>`: `Ruah` (packaged; `Ruah <Name>` for a
  flavor) or `Ruah Dev-<id>` for a checkout, `<id>` = the first 8 hex digits of the
  SHA-256 of the checkout's real path — one dev instance per worktree, each seeded once
  with the viewer's Local Storage from `…/Ruah`.
- A launch that finds its profile's lock taken quits after handing over its folder
  (`second-instance`) and prints on stderr
  `[ruah] <app> is already running with this profile (<userData>, pid <pid>); handed <folder> to it.`
  (or `brought it to the front.`; the pid from Chromium's `SingletonLock`).
- Logs: main and daemon output go to `daemon.log` in `$RUAH_HOME/logs` (when set), else
  `~/Library/Logs/<profile>` (dev: also mirrored to the terminal). Rotated to
  `daemon.1.log` whenever the next write would take it past 5 MB — at startup and while
  the app runs (one previous file kept). Lines main adds: the start banner (`--- <app>
  <version> (dev, <checkout> | app) <time> ---`), `[ruah] opening <folder> (<source>)`,
  `[ruah] window loaded <url> "<title>" in <ms> ms`, window load failures, viewer crashes,
  `[ruah] backend exited (<code>)`, `[ruah] restart failed: …`.

### 19.6 `ruah app doctor [--json] [--no-login-shell]` (no daemon)

Which tools Ruah can find on the `PATH` the desktop app uses (§19.2: login shell first,
then this process's; `--no-login-shell` skips the shell), and which variables the app
takes from the shell profile. Exit 0 (it is a diagnosis).

```ts
interface DoctorReport {
  version: string;
  shell: string;                                 // the login shell asked
  loginShell: { ok: true; ms: number } | { ok: false; ms: number; error: string } | { ok: false; skipped: true };
  path: string;                                  // the PATH searched
  environment: {
    bare: boolean;                               // this process has launchd's bare PATH (not a terminal)
    fromLoginShell: string[];                    // variables the login shell exports that this process lacks (names only, §19.2 step 3)
  };
  tools: { name: string; label: string; group: "agent" | "source" | "cloud"; path: string | null }[];
  home: string;                                  // $RUAH_HOME (default ~/.ruah)
  app: string | null;                            // the Ruah.app `ruah app` opens (null: this checkout's Electron)
}
```

Tools: agents `claude`, `cursor-agent`, `grok`, `kiro-cli`, `opencode` (looked up like the
agent presets: PATH, `~/.local/bin`, their installers' dirs, `RUAH_*_BIN`); `git`, `gh`,
`ruah`; cloud `doctl`, `aws`, `gcloud`, `az`, `wrangler`, `vercel`, `supabase`, `kubectl`,
`railway`, `flyctl`/`fly`, `netlify`, `hcloud` (PATH + Homebrew dirs, like
`src/integrations/exec.ts`).

### 19.7 Build (`pnpm dist`, `pnpm dist:app`)

- `pnpm build && pnpm ui:build`, then electron-builder `--mac --arm64` with
  `electron-builder.config.cjs`; `dist:app` stops at the `.app` (`--dir`). Output:
  `release/` (git-ignored). `npmRebuild: false`, `electronLanguages: ["en"]`, dmg
  format ULFO, window 540×380 with `electron/build/dmg-background.tiff`.
- `afterPack` (`scripts/macos/after-pack.cjs`): makes node-pty's `spawn-helper` and
  `Resources/bin/ruah-app` executable; fails if either is missing, or if
  `Resources/THIRD_PARTY_NOTICES.md` is missing or lacks the T3 Code, shadcn/ui or OFL
  notice.
- Fuses are flipped after `afterPack`, before signing (§19.1).
- `afterSign` (`scripts/macos/after-sign.cjs`): with the signed app, as Node:
  `dist/cli.js --version`, a node-pty pty round trip, resolving Claude's native CLI and
  running `claude --version` (throwaway `HOME`), `codesign --verify --strict` on it, the
  fuse wire of the signed framework (read with electron-builder's `@electron/fuses`) against
  the four states above, and by behaviour: `NODE_OPTIONS=--require /nonexistent/…` must not
  stop `-e`, and `--disable-sigusr1` must be accepted. Any failure fails the build.
- `RUAH_APP_FLAVOR=<name>`: a side-by-side build (§19.1 flavors).
- Signing (`scripts/macos/signing.cjs`): ad-hoc (`identity: "-"`, no hardened runtime) unless
  `RUAH_MAC_IDENTITY` (not `-`), `CSC_LINK` or `CSC_NAME` is set — then the hardened
  runtime with `electron/build/entitlements.mac.plist` (allow-jit,
  allow-unsigned-executable-memory, disable-library-validation), and notarization when
  `APPLE_API_KEY`+`APPLE_API_KEY_ID`+`APPLE_API_ISSUER`, `APPLE_ID`+
  `APPLE_APP_SPECIFIC_PASSWORD`+`APPLE_TEAM_ID` or `APPLE_KEYCHAIN_PROFILE` are set. The
  keychain is never searched for an identity implicitly.

## 20. Projects UX: new project wizard, stable pins, groups, Home (2026-09-26)

Working on several projects without friction: a wizard that creates a project from an
offline template (the same library backs `ruah app new`, no daemon needed), pinned
projects that keep the order you give them, free-form groups (tags) for clients / "Job",
and a Home page that shows every project sorted by what needs you. All additions are
optional fields or new endpoints; older viewers keep working. Code: `src/projects/create.ts`,
`src/projects/templates/`, `src/projects/overview.ts`, `src/projects/run-new.ts`,
`src/contracts/{projects,overview}.ts`; viewer `ui/src/lib/{new-project,home,rail,start-screen}.ts`,
`ui/src/components/projects/NewProjectWizard.tsx`, `ui/src/components/dashboard/HomePage.tsx`.

### 20.1 New project

Every endpoint below passes the same Origin check as `/ws` (403 otherwise) — the GETs
too, because they run `git` / `gh`. A GET with no Origin header passes that check (curl, the
viewer's own same-origin fetches), so the GETs also refuse a browser request that says
`Sec-Fetch-Site: cross-site` or `same-site` without an Origin — an `<img src>` or a `no-cors`
fetch from another page — with 403. (Such a page could never read the answer; this keeps it
from making the daemon run `gh auth status` or git at all.) Nothing here overwrites anything:
the target folder must not exist (not even empty) and is claimed with an exclusive `mkdir`;
files are written with the `wx` flag.

Locations: `~/…` is expanded against the daemon's home, and a relative `parentDir` / `system`
("Projects") is taken from **home** too — never from the daemon's own working directory, which
means nothing to the person typing (the CLI, §20.6, keeps the current folder).

| Method + path | Body / result |
| --- | --- |
| `GET /api/projects/new` | `NewProjectDefaults = { parentDir, parentSource, home, templates: TemplateInfo[], git: { installed, identity } }` — `parentDir` is the remembered folder (`$RUAH_HOME/settings.json` `newProject.parentDir`, set by every create in the app), else `~/Projects`, else the parent of a recent project, else home — the first that exists; `parentSource` says which (`"remembered" \| "projects" \| "recent" \| "home"`; the wizard says "Remembered from your last new project" only for `"remembered"`). `identity` = `user.name` and `user.email` are set (needed for the first commit). |
| `GET /api/projects/new/github` | `{ installed: boolean; loggedIn: boolean; login?: string }` from `gh auth status --json hosts` (read-only, no token is read or printed; cached 60 s). Asked only when the wizard's options step shows. |
| `POST /api/projects/new/check` | `{ parentDir, name }` → `NewProjectCheck = { path, ok, name: { ok, error? }, parent: { path, exists, isDir, writable }, target: { exists, empty? }, problems: string[] }`. No side effects; `path` (the folder that would be created) and `parent.path` are absolute — resolved as above — and the wizard shows `path` as its "Creates" line. `parent.writable` for a missing parent = its nearest existing ancestor is writable (it can be created with `createParent`). |
| `POST /api/projects/create` | §5.3 body plus, all optional: `template` (id, default `"empty"`), `commit` (initial commit, default = `git`), `github: { visibility: "private" \| "public", name? }` (runs `gh repo create` — **only when present**), `system` (a folder holding `ruah.system.json` to add the repo to), `createParent` (default false → 404 when the parent is missing). Answers the `ProjectInfo` as before plus `created: CreateReport`. |

```ts
interface TemplateInfo { id: string; name: string; description: string; files: string[] /* top-level, folders end with "/" */; run?: string; setupPrompt: string }
interface CreateReport {
  path: string; template: string; files: number;
  scanned: { nodes: number; edges: number } | null;          // null = the empty map ("empty")
  git: { init: boolean; branch: string | null; commit: string | null; warning?: string } | null;
  github: { command: string[]; ran: boolean; url?: string; error?: string } | null;
  system: { root: string; repoId: string | null; error?: string } | null;
  warnings: string[];
}
```

Create, in order (serialized with opens): validate the name (a plain folder name: no
slashes, control characters, leading dot, `: * ? " < > |`, ≤ 255 chars) and the template
→ resolve the parent (`~/` expanded; `createParent` makes it) → exclusive `mkdir` of
`<parent>/<name>` (409 exists, 403 permission) → template files → `architecture.json`
(scanned from the files with the infra layer; the "empty" template writes an empty map)
→ `git init` (the user's `init.defaultBranch`, else `-b main`). A failure up to here removes
everything it created (the folder, and the parents it created — each only while it is still
empty, so a parent that meanwhile received another project, say from `ruah app new` running at
the same time, is kept) and answers 500 "… — nothing was created". Then, warning only (the project is kept, `warnings` says what to do): the initial
commit (`Initial commit (Ruah: <template>)`; skipped without a git identity), adding the repo
to the system, and `gh repo create <repo> --private|--public --source . --remote origin
[--push]` (`--push` only with a commit; repo name = `github.name` or the folder name as a
slug, `^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$` — never starting with `-`, which gh would read as a
flag, and never `.` / `..`; a bad name is a 400 before anything is created). When gh exits 0
but prints no repository URL, nothing confirms the repository exists: `github` has no `url`
and `warnings` gains "GitHub repo not confirmed: …" (never reported as created). git and gh
run through `execFile` with an args array (no shell), a timeout and no prompts. Then the project is opened (§5.3 open) and the Home
overview cache is dropped. Errors: 400 bad name / unknown template / git missing / GitHub
without git / not a system folder, 404 parent missing, 409 target exists, 403 Origin or
permission, 500 write / scan / git init failed.

### 20.2 Templates (offline, shipped in `src/projects/templates/`)

| id | name | writes | run |
| --- | --- | --- | --- |
| `empty` | Empty | README, `.gitignore`, an empty `architecture.json` (the viewer opens it in Edit mode) | — |
| `web-vite-react` | Web app (Vite + React + TS) | Vite + React 19 + strict TS app | `pnpm install && pnpm dev` |
| `node-api-ts` | Node API (TypeScript) | Node 22 `http` API with a tiny router, `node:test` tests | `pnpm install && pnpm dev` |
| `static-site` | Static site | HTML, CSS, JS, no build step | `open index.html (or Ruah's Preview)` |
| `pnpm-monorepo` | Monorepo (pnpm workspaces) | an API app + a shared package, one tsconfig base | `pnpm install && pnpm dev` |
| `infra-terraform` | Infra (Terraform + GitHub Actions) | Terraform with dev / prod variables, a workflow that fmt-checks, validates and plans (never applies) | `cd terraform && terraform init && terraform plan` |

Templates render from TS modules with `{ name, slug, year }` — no network, no installs, no
downloads. Every path is checked to stay inside the new folder.

### 20.3 Pinned order and tags

`ProjectInfo` gains (all optional):

```ts
pinOrder?: number;   // pinned only: 0 = ⌘1, 1 = ⌘2, …
pinnedAt?: string;   // pinned only: ISO, when it was pinned
tags?: string[];     // free-form groups ("Acme Studio", "Job", "Freelance"); the first is the project's group
```

- The recent list sorts pinned projects by `pinOrder` (then most recently opened), then the
  rest most recently opened first. A new pin goes last; opening a project never changes the
  pinned order (before §20 pins were sorted by `lastOpenedAt`, which renumbered ⌘1…⌘9 on every
  switch). Unpinning drops `pinOrder` / `pinnedAt`; `pinOrder` is renumbered 0…n-1 on every write.
- Migration: a registry written before §20 (pins without `pinOrder`) is read with the pins in
  the order they were listed (most recently opened first) and saved that way with the next change.
- `POST /api/projects/reorder` `{ ids: string[] }` (≤ 200) → `ProjectsList` (§5.3 `GET
  /api/projects` shape). `ids` first, in that order (unknown or unpinned ids are ignored), then
  the pins it leaves out in their current order.
- `POST /api/projects/tags` `{ id, tags: string[] }` → `ProjectInfo` (404 unknown id). Tags are
  normalized: control characters removed, whitespace collapsed, ≤ 40 chars, duplicates ignoring
  case dropped, at most 6, empty ones skipped; `[]` removes them. When several spellings of one
  tag are in use, the one most projects use names the group (a tie: the capitalized one).
- `project.json` (per project, for chat listings) never carries the order fields.
- A viewer that kept a local pin order for an older daemon (`localStorage`
  `ruah.rail.pinned.v1`) sends it once as a reorder when it first meets a §20 daemon, so the
  numbers people know survive the upgrade.

### 20.4 WebSocket: `projects.changed`

daemon → every viewer `{ type: "projects.changed", recent: ProjectInfo[] }` after pin, unpin,
reorder, tags and forget (not on open / switch — `project` covers those): one list, one ⌘1…⌘9
order in every window. Viewers replace their recent list (and the open project's pins / tags).

### 20.5 Home overview — `GET /api/projects/overview?limit=24`

The Home page's cards in one batched answer (`limit` 1…50, default 24; Origin-checked):

```ts
interface ProjectsOverview { at: string; projects: ProjectOverview[] }   // the recent list's order
interface ProjectOverview {
  project: ProjectInfo; current: boolean; exists: boolean;               // always true: missing folders are left out (as in GET /api/projects)
  lastViewedAt: string | null;                                           // §13.5
  lastChat: { id; title; agentId; updatedAt; turnCount; lastPrompt: string | null; lastReply: string | null } | null;  // the active (else newest) chat; texts ≤ 200 chars
  since: { from; turnsFinished; turnsFailed; permissionsRequested; filesTotal; mapChanges };   // activity since lastViewedAt (§13.4)
  lastEvent: ActivityEvent | null;                                       // newest turn.finished / permission.requested / agent.error
  unread: number;                                                        // §13.5 unread turns, all chats
  live: { running: number; waitingPermission: number };                  // background agents now (§13.1)
  permissions: { requestId; turnId; chatId: string | null; title; options: PermissionOption[] }[];  // waiting now
  git: GitState;                                                         // §13.4, cached 5 s per repo, ≤ 4 repos at a time
  cloud: { inScope; healthy; degraded; down; deploying; unhealthy: string[]; syncedAt: string | null } | null;  // from the cloud cache in the §14 scope (no provider call; cached 30 s); null = nothing synced / in scope
  preview: { state: "starting" | "running" | "crashed"; url: string | null; exitCode: number | null } | null;  // §18, this daemon run
}
```

Cheap on purpose: the activity log is read once per answer; the static part (chats, git,
cloud) is cached ~4 s and recomputed early when a new activity event arrives; chat previews
are re-read only when a chat's `updatedAt` moves; live counts, permissions and previews are
read on every call. A permission is answered from Home with the ordinary WS
`permission.response` — the daemon routes it to whichever project's agent asked (§13.1), no
switch needed.

Viewer ranking (`ui/src/lib/home.ts`): a waiting permission > a failed turn > cloud down > a
crashed preview > finished while you were away (unread) > cloud degraded > an agent working >
uncommitted / unpushed > quiet; ties: pinned in ⌘ order, then most recently opened. Live
counts come from the activity feed (§13.2) when it is connected, else from the answer. The
page refreshes on activity (debounced) and every 30 s while visible. Filters: All · Pinned ·
one per tag in use.

### 20.6 CLI — `ruah app new` (no daemon)

```
ruah app new <name> [--in <dir>] [--template <id>] [--no-git] [--no-commit]
                    [--gh private|public] [--gh-name <repo>] [--system <dir>]
                    [--create-parent] [--json]
ruah app new --templates [--json]
```

Same library and rules as §20.1, except that a relative `--in` / `--system` is taken from the
current folder (a shell's usual meaning). `--in` defaults to the current folder; git init + an
initial commit are on by default; `gh repo create` runs only with `--gh` (when gh is installed
and a commit exists, the text report prints the command to run by hand instead). The text
report says `GitHub: <url>`, `GitHub: not created — <why>` (plus the retry command), or
`GitHub: not confirmed` when gh printed no repository URL. `--json` prints
the `CreateReport` (errors: `{ error, status }`). Exit codes: 0 created, 1 failed (nothing left
behind), 2 bad arguments.

### 20.7 Viewer behaviour

- **Start screen**: covers the shell only when no project is open, or when asked for (⌘K →
  Start screen, Settings → Getting started). A reload never covers an open project. The
  Getting started card shows only on a true first run (never dismissed, nothing ever opened);
  when that first run opened a repo straight away (`ruah app ~/repo`: the list holds only it),
  the card waits on the start screen and a one-time toast ("New to Ruah?", `localStorage`
  `ruah.onboarding.offered.v1`) points to it — nothing covers the project. A profile that
  already has projects shows no card. Only dismissing the card sets `ruah.onboarded.v1`. With
  no daemon (the bundled sample) a first run opens the start screen with the card over the
  sample.
- **Permission shortcut** (every PermissionCard): Enter = allow once only
  when the key can't mean anything else — it lands on `<body>`, a disabled field (the composer
  while the agent works) or a non-interactive part of the card. A key on any button, link,
  tab, option, field, editor, dialog or menu belongs to that control (Enter on a Home card or
  its "Reject" quick action clicks it); an already-handled key is ignored. Esc answers nothing
  (2026-09-26: it sent `cancelled`, which stops the whole turn, and a stray second Esc killed the
  agent's work). Every "Reject" — the card, Home, the bell — sends the `reject_once` option
  (this call is declined, the agent carries on); only the composer's Stop cancels a turn.
- **Wizard** (⇧⌘N; ⌘N on the start screen): name + location (live check, final path shown) →
  starting point → options (git + first commit on; GitHub off, private, only with gh logged
  in, the exact command shown; add to a system when one is known; ask the agent with an
  editable first prompt). Enter next, ⌘Enter create, Alt+← back. The "Creates" line shows the
  folder the daemon resolved (`NewProjectCheck.path`), and a check counts only for the input it
  answers (while the debounced check for a new input runs: "Checking…", no Next / Create). The
  shown `gh` command has `--push` only when the first commit will be made (commit on and a git
  identity). After creating: the map, a first-run hints card (sessionStorage
  `ruah.newProject.hints.v1`) and — when asked — the first prompt, sent once the project's agent
  is ready; the card says the agent "is setting it up" only after the prompt went out to an
  agent that isn't in error (else: waiting for it to start, it can't start, or the prompt was
  lost to a reload).
- **Home** is `/` (the Ruah mark, G H); the open project's dashboard is one click away at
  `/?view=project` with everything it had. Filter choice: `localStorage` `ruah.home.filter.v1`.
- **Pins**: drag a pinned row (or Alt+↑/↓) in the Advanced sidebar or All projects to change
  ⌘1…⌘9 (`POST /api/projects/reorder`). ⌘1…⌘9, the rail, the sidebar, the launchers and Home
  all read the daemon's order.
- **Groups in the rail**: once two or more projects share a tag, a small switcher above the
  Standard rail's project tiles shows one group at a time (`localStorage`
  `ruah.rail.group.v1`); the open project always keeps its tile, projects of other groups are
  counted in the "+N" tile, and ⌘1…⌘9 stay the global pin numbers. With no shared tag there is
  no switcher.

---

## 21. Daily-driver fixes: opt-ins, safe renames, repo hygiene (2026-09-26)

Additions and behaviour changes from the daily-driver fixes. Everything is backwards
compatible: new fields are optional for older daemons and viewers, which ignore them.

### 21.1 Reading an agent app's saved login is opt-in

Cursor's plan usage (§16.2) needs the **Cursor app's** saved login (`state.vscdb`
`cursorAuth/accessToken`). Ruah reads it only when the user allowed it:

- Saved as `usage.readAppLogins` (boolean) in `$RUAH_HOME/settings.json`, **default off**.
  `RUAH_USAGE_READ_LOGINS` (`1/true/on/yes`, `0/false/off/no`) overrides the saved value for
  one process and locks the switch in the app. `SettingsStore` re-reads the file when another
  process (the CLI) changed it — a daemon checks every 3 s — and a change found that way is
  handled like one made in the app (the Cursor reading is dropped, every window gets a new
  `activity.snapshot`).
- `UsageSettingsView = { readAppLogins: boolean; source: "settings" | "env" | "default" }`.
- WS (§13.6): `settings.set` takes `usage?: { readAppLogins?: boolean }`; `AppFeatures` (in
  `activity.snapshot`) gains `usage: UsageSettingsView`. A socket whose upgrade `Origin` is not
  the daemon's own origin (another localhost port, an `--allow-origin` site) gets
  `error` `bad_message` for a `settings.set` carrying `usage`, and nothing changes.
- HTTP: `GET /api/usage/settings` → `UsageSettingsView`, with the checks of every
  `/api/usage/*` route: a loopback / IP-literal / bound Host (DNS rebinding), an allowed
  `Origin` when there is one (403), and no `Sec-Fetch-Site: cross-site` without one.
  `POST /api/usage/settings` `{ readAppLogins: boolean }` (JSON ≤ 4 KiB; 400 otherwise) →
  `UsageSettingsView` takes the stricter rule of extension changes (§17.3,
  `src/serve/local-mutation.ts`): a loopback peer and Host, `Content-Type: application/json`
  (415 otherwise, so a no-preflight `text/plain` POST fails), `Sec-Fetch-Site` same-origin or
  none, and an `Origin`, when sent, that is the Host's own (403) — only the viewer this
  daemon serves, or a client without an Origin. Changing it drops the cached Cursor reading,
  so the card is re-read at once, and every window's Settings → Features follows.
- `AgentLimits.appLogin?: { readAppLogins; source; app }` on the Cursor card. While off, the
  card shows the tier, `status: "partial"`, a `reason` saying the numbers need the app's
  login, and the switch ("Read Cursor's saved login to show plan usage — the token stays in
  memory and is never stored"); the app is not even opened.
- CLI: `ruah app usage settings [--read-app-logins on|off] [--json]` (same file, no daemon;
  a running daemon picks the change up); `ruah app usage limits` follows the saved value.
  While `RUAH_USAGE_READ_LOGINS` is set it prints the saved choice and how to unset the
  variable instead of the `--read-app-logins` hint.

### 21.2 System repos: no rename under a running turn; Suggest connections stops

- `POST /api/system/repos/rename` answers **409** (with the reason) while any turn of the
  system (any chat, foreground or background) runs or waits for its agent: the turn stores
  its record (element ids included) when it finishes and would write the old ids back.
  `ruah app system rename` asks a running daemon first (`--daemon <url>`, default
  `RUAH_DAEMON_URL` / §13 default) and refuses the same way (exit 1); `--offline` skips the
  check. When no daemon answers it renames and says so on stderr (the desktop app uses
  another port when 4177 is taken: pass `--daemon`).
- "Suggest connections" is capped: `RUAH_SUGGEST_TIMEOUT_MS` (≥ 1000, default 10 min). On
  timeout or cancel the run ends at once, its agent turn is cancelled, and `lastRun.error`
  says why ("timed out after 10 min waiting for your permission (…)", "cancelled").
- `POST /api/system/suggestions/cancel` `{}` → `SuggestionsView` (409 when nothing runs).
- `SuggestionsView.running` gains `turnId?`, `deadline` (ISO) and `waitingPermission?` (the
  first permission request the turn waits on, as in `permission.request`: `requestId`,
  `toolCall`, `options`). The Connections tab shows it with its answer buttons, the time
  left and a Stop button.

### 21.3 What Ruah writes into a repository

Only committable files, and only on an explicit user action:

| File | Written by |
| --- | --- |
| `.ruah/verify.json` | `ruah verify init` / by hand, or `POST /api/engines/verify/sync` with ruah workflow tasks that carry acceptance criteria (never by a verify run; the viewer has no sync button — its element inspector has **Verify**) |
| `.ruah/cloud.json` | cloud scope changes (§14) |
| `.ruah/extensions.json` | enabling / editing a project extension (§17) |
| `.ruah/preview.json` | "Save to the repo" in the Preview (off by default; §18) |
| `.ruah/links.json` | linking a work item (§6) |
| `.ruah/suggestions.json`, `.ruah/system-scan.json` | a system folder (§12) |

- Caches and run outputs live in `$RUAH_HOME/projects/<projectId>/cache` (the id of the real
  path): verify badges (`verify-nodes.json`), per-node criteria slices, eval specs and
  results (`cache/evals`). A missing `ruah eval` writes nothing.
- The Preview's pick is remembered on this computer, in
  `$RUAH_HOME/projects/<projectId>/preview.json` (same format as §18.3), which wins over the
  repo's file. `POST /api/preview/start` `remember: true` and `POST /api/preview/choice` write
  there; `saveToRepo: true` on either writes `.ruah/preview.json` instead (and drops this
  computer's copy). `PreviewDetection.choiceFrom?: "local" | "repo"` says where `choice` came
  from. The viewer offers "Save to the repo (.ruah/preview.json)" — a checkbox, off by default,
  in the custom-command dialog and an item in the command menu. CLI: `ruah app preview
  --remember` keeps the pick in `$RUAH_HOME`, `--save-to-repo` writes the repo file.
- Verify after an agent turn runs only when the repo has criteria (`.ruah/verify.json` with
  more than the placeholder older versions wrote) and `ruah verify` is installed. An explicit
  Verify (the element inspector's **Verify**, `POST /api/engines/verify/run`) without criteria
  answers `unverifiable` with the fix (`ruah verify init`) and writes nothing. Sync
  criteria with nothing to sync writes nothing either: `POST /api/engines/verify/sync` →
  `{ path, criteriaCount: 0, written: false }` (`written: true` otherwise).
- Whenever Ruah writes a committable file into a repo's `.ruah/`, it makes sure
  `.ruah/.gitignore` ignores `.cache/` (created with a two-line header, or one line appended;
  never rewritten) — except while a `.ruah/.cache/` folder exists: after the migration below
  what is left there is the user's, and must not silently drop out of git. Reads and the
  migration never create or change `.ruah/.gitignore`.
- Migration, once per project (recorded in `$RUAH_HOME/projects/<projectId>/cache/
  repo-migration.json`, on the first verify read): the old `.ruah/.cache/verify-nodes.json` is
  merged into the home cache and deleted, the `verify-<node>.json` criteria slices are
  deleted, the old eval specs and results in `.ruah/evals/` (`node-<id>.json`,
  `results-<id>-<ms>.json`) are moved to `cache/evals`, and each of those folders — and
  `.ruah/` — is removed when that leaves it empty. Only Ruah's own files are touched, and
  never one git tracks (`git ls-files`, asked only when an old folder exists): a committed
  file is copied to the home cache but stays, reported as a leftover. Later reads write
  nothing, in the repo or in `$RUAH_HOME`.
- `GET /api/engines/verify/state` adds `legacy?: { placeholderCriteria?: ".ruah/verify.json";
  leftover?: string[] }`: the repo's `.ruah/verify.json` is exactly the placeholder older
  versions wrote on their own, and Ruah's old cache files still in the repo (committed, or
  not deletable). The
  viewer shows it once per project and session: "Remove" calls
  `POST /api/engines/verify/remove-placeholder` `{}` → `{ removed: true, path }` (409, nothing
  removed, unless the file is exactly that placeholder; `.ruah/` goes when that leaves it
  empty); "Keep" stops asking for that project (viewer `localStorage`).
- Not changed: `architecture.json` at the repo root is the map itself
  (architecture-as-code, DESIGN-NOTES "Data"); a folder without one is scanned and gets one
  when it is opened.

### 21.4 Verify state is per project

`GET /api/engines/verify/state` answers `{ root: string | null, nodes }` (was `{ nodes }`):
the daemon keeps results per project root. The viewer clears badges on a switch (and during
one) and drops an answer whose `root` is not the open project's.

### 21.5 The bundled sample never reaches a daemon

While the viewer shows the bundled sample ("Explore the sample", or no daemon yet), nothing
it does reaches a daemon. Engine calls (guard, opt, eval, conv, replay), the projects API
(`daemon.ts` `api()`), preview actions, the system dialogs and the draw.io export answer with
`SAMPLE_MODE_MESSAGE` instead; the integrations, extensions, usage and drill-in (expand)
clients are bound to the daemon's origin only while `source === "daemon"`, so they make no
request at all. All engine calls go to the daemon's origin (not relative URLs). A daemon's
first `project` frame drops the sample (map, turns, drafts), whatever project it names —
including none (launcher).

### 21.6 Engine status reads the toolkit (addition to §8)

`GET /api/engines/status` finds the toolkit behind the `ruah` bin (an npm symlink into
`@ruah-dev/cli`, or the shell shim Homebrew installs) and reads its `@ruah-dev/*`
`package.json` files the way ruah-cli discovers namespaces (real folders only; `orch` and
`conv` from the CLI itself). Nothing is spawned; the answer is cached until that folder
changes. Each entry gains `via?: "ruah" | "bin" | "workspace"` when installed. A `ruah`
that cannot be inspected is still tried, as before. The viewer re-reads status when the
daemon connects or the project changes (one shared read per 15 s; failures not cached).

### 21.7 Tasks outside a git repository (addition to §6)

`GET /api/ruah/status` answers `{ initialized: false, reason, hint }` without running ruah
when there is nothing to show: `reason` ∈ `cli_missing | no_project | not_git |
not_initialized` (`not_git`: no `.git` folder or file up the tree; checked without a spawn).
Workflows are empty there, mutations answer 409 with the fix, and the ruah integration card
says so. Any other ruah failure is one readable line (no colours, source excerpt, stack
frames or Node banner).

### 21.8 Smaller behaviour changes from the sweep

- §9 Kubernetes: kubectl with no context at all (no kubeconfig) is `not_connected` ("no
  contexts in your kubeconfig — add your cluster with its provider's CLI (…)", hint
  `kubectl config get-contexts`: a real, harmless command, since the card can run it)
  instead of an `error` from asking localhost:8080; it is no longer listed as "could not
  read".
- §18 preview logs: kept lines lose spinner frames (`⠙`) as well as colours; a line left
  empty is dropped. The crash reason prefers the thrown error's own message and never picks a
  stack frame, the error object's dump, Node's banner or npm's footer / notices.
- §12.1: writing `.ruah/system-scan.json` also ensures `.ruah/.gitignore` (§21.3).
- Viewer: a page opened with `?daemon=` keeps using that daemon after in-app navigation;
  a palette click adds the element right of the level's elements (drag-and-drop is unchanged);
  the Replay button is hidden while `ruah watch` is not installed.

## 22. CI, tagged releases and repository hygiene (2026-09-26)

What GitHub runs for this repository and what a release publishes. Code:
`.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/dependabot.yml`,
`test/repo-hygiene.test.ts`.

### 22.1 CI (`ci.yml`)

- Triggers: every `pull_request`, `push` to `main`, `workflow_dispatch`. A newer run on the
  same pull request cancels the older one.
- Matrix: `macos-15` (Apple silicon; required) and `ubuntu-24.04` (`continue-on-error`
  until it has proven green: node-pty compiles from source there).
- Steps, in order: checkout (`persist-credentials: false`) → pnpm from `package.json`
  `packageManager` → Node from `.nvmrc` (pnpm store cached) → Bun 1.3.9 →
  `pnpm install --frozen-lockfile` → `(cd ui && bun install --frozen-lockfile)` →
  `pnpm typecheck` → `pnpm build` → `pnpm test` → `(cd ui && npx tsc --noEmit)` →
  `(cd ui && bun run build)` → CLI smoke (`--version`, `help`,
  `scan test/golden --dry-run`, on a temporary `RUAH_HOME`).

### 22.2 Releases (`release.yml`)

- Trigger: a pushed tag `v*`. The tag must equal `v` + `package.json` `version`, or the
  run fails before building. `workflow_dispatch` is a dry run: same build, workflow
  artifact only, no release.
- Job `dmg` (`macos-15`, token `contents: read`, no dependency cache): the §22.1 gates,
  then `pnpm dist --publish never` (§19.7), then `release/SHA256SUMS.txt`. For tags it
  runs in the GitHub Environment `release` (`environment: ${{ startsWith(github.ref,
  'refs/tags/v') && 'release' || '' }}`); a dry run has no environment.
- Job `publish` (only for tags; `ubuntu-24.04`; token `contents: write`; runs no project
  code): downloads the artifact and creates the release as a **draft** titled
  `Ruah v<version>` (a prerelease when the tag contains `-`), or uploads with `--clobber`
  when the release exists. A maintainer publishes the draft.

| Artifact | Contents |
| --- | --- |
| `Ruah-<version>-arm64.dmg` | the app (§19), ad-hoc signed unless the secrets below are set |
| `SHA256SUMS.txt` | one line per `.dmg`: `<sha256>  <file name>` (`shasum -a 256 -c SHA256SUMS.txt`) |
| workflow artifact `ruah-macos-arm64` | both files, kept 14 days (also for dry runs) |

Optional secrets of the `release` environment (none set = ad-hoc signing, no
notarization). They belong in the environment, whose deployment rule allows only tags
`v*`, and not in repository secrets: then a dry run, or a run of an edited workflow from a
branch, never receives them, and a dry run is always ad-hoc signed.

| Secret | Becomes (§19.7) |
| --- | --- |
| `MAC_CERT_P12_BASE64` | decoded to `$RUNNER_TEMP/developer-id.p12` → `CSC_LINK` (without it: `CSC_IDENTITY_AUTO_DISCOVERY=false`) |
| `MAC_CERT_PASSWORD` | `CSC_KEY_PASSWORD` (build step only) |
| `APPLE_API_KEY_P8` | written to `$RUNNER_TEMP/AuthKey.p8` → `APPLE_API_KEY` (only with the certificate) |
| `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | the same names (build step only) |

The `.p12` and `.p8` files are removed at the end of the job, whatever its outcome.

`SHA256SUMS.txt` comes from the same release as the `.dmg`: it shows a download is
complete and uncorrupted, not that nobody replaced both. Authenticity comes from the
release page itself (github.com, the maintainers' account) and, once configured,
Developer ID signing and notarization.

### 22.3 Workflow rules

- Top-level `permissions: contents: read`. No `<scope>: write` anywhere in `ci.yml`
  (top level or job level); in `release.yml` exactly one, `contents: write` in the
  `publish` job. No `pull_request_target`, no `write-all`.
- Signing secrets are read only in `release.yml`'s `dmg` job, which enters the `release`
  environment for tags only (§22.2).
- Every `uses:` is pinned to a full 40-character commit SHA with the version in a comment;
  Dependabot (`github-actions` ecosystem) bumps the pins.
- Every checkout sets `persist-credentials: false`.

### 22.4 Dependabot (`dependabot.yml`)

Weekly (Monday), grouped minor + patch updates, a 3-day cooldown: `npm` at `/`
(pnpm-lock.yaml; dev and runtime groups), `bun` at `/ui`, `github-actions` at `/`.
Commit prefixes `chore(deps)`, `chore(deps-ui)`, `ci`.

### 22.5 Repository hygiene (`test/repo-hygiene.test.ts`, part of `pnpm test`)

Over `git ls-files` (skipped outside a git checkout; lockfiles excluded from text checks):

- no home folder — `/Users/<name>`, `/home/<name>`, the dash-encoded `-Users-<name>-`
  that coding-agent tools use for folder names, `C:\Users\<name>` (also with doubled
  backslashes) — except `me`, `you`, `dev`, `other`, `someone`, `user`, `runner`, `x`,
  and no macOS per-user temp folder (`/var/folders/<2>/<20+>`);
- no full-length token shapes: AWS access keys, GitHub (`ghp_…` 36 chars, `github_pat_…`),
  Anthropic `sk-ant-…`, OpenAI `sk-…`, Slack, Google `AIza…`, DigitalOcean `do?_v1_…`,
  Supabase `sbp_…`, Stripe live keys, npm tokens, PEM private keys;
- no `.env` files (except `.env.example`), `.p12` / `.p8` / `.pem` / `.key` / `.cer` /
  provisioning profiles, `.dmg` / `.zip` / `.asar` / `.app` / `.exe` / `.node`, nothing
  under `dist/`, `dist-electron/`, `release/`, `viewer/`, `out/`, `node_modules/`,
  `.output/`;
- no file over 1 MiB;
- the §22.3 workflow rules; `package.json` `repository`, `homepage`, `bugs`, `license`,
  `packageManager` and `private: true`; the `.gitignore` entries for build output,
  secrets and `/.ruah/`; README, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, CHANGELOG,
  THIRD_PARTY_NOTICES, the pull request template and `dependabot.yml` exist;
- when `RUAH_PRIVATE_TERMS_FILE` is set (a file kept outside the repo: one term per
  line, `#` comments, terms shorter than 3 characters ignored), no tracked text file
  contains any term, case-insensitively; failures name the file and the term's line
  number in the terms file, never the term. Set but unreadable (a typo, an unexpanded
  `~`) or without a single term: the check fails. Unset: the check is skipped.

The patterns live in `scripts/privacy/patterns.ts`, shared with §22.6.

### 22.6 History scan (`pnpm privacy:scan`)

`scripts/privacy/scan-history.ts` checks every object reachable from any ref — what
`git push --mirror` would publish — for the private terms, the §22.5 home folders and
secret shapes:

- file contents (every blob `git rev-list --objects --all` lists, read with
  `git cat-file --batch`; a `missing` object is an error), folder and file names (tree
  entries), commit and annotated-tag messages (not author lines), ref names;
- options: `--repo <dir>` (default `.`), `--terms <file>` (default
  `$RUAH_PRIVATE_TERMS_FILE`; set but unreadable or empty exits 2), `--expect-hits`;
- output: counts of refs, commits, tags, folders, files and bytes scanned, then per
  check (`private term on line <n>`, a home-folder shape, a secret shape) the number of
  objects by kind and up to 8 of them (short id + path); a path or ref name that
  contains a term or home folder is shown as hidden. Terms are never printed;
- exit 0 nothing found, 1 something found, 2 usage error, unreadable or empty terms
  file, not a git repository, or commits without a single file read (a broken scan never
  looks clean);
- `--expect-hits` is the positive control for a history rewrite: on the ORIGINAL history
  it exits 0 only when a private term is found (any check without a terms file). The
  procedure: control on the original (must pass) → `git filter-repo` on a fresh mirror
  clone (`--replace-text` for contents, `--replace-message` for commit messages,
  `--path-rename` / `--invert-paths` for names) → scan the rewritten clone without
  `--expect-hits` (must exit 0).
