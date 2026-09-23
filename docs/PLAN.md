# PLAN.md — archmap

Status: plan only, no product code. Written 2026-09-16 against:

- Lovable export `Architect's Canvas/` — TanStack Start 1.168 + React 19 + Tailwind 4 + shadcn, hand-built SVG canvas (no graph library), zero backend calls, all data hard-coded in `src/data/graphs.ts`.
- `t3code` at `eff44be4` (2026-09-16), upstream `pingdotgg/t3code`, MIT.
- ACP `protocolVersion: 1`; `@agentclientprotocol/sdk` 1.4.0; `@agentclientprotocol/claude-agent-acp` 0.78.0 (handshake verified on this machine).

Companion files: CONTRACTS.md (the three contracts), BORROW.md (t3code borrow list + license), ASSUMPTIONS.md.

## 0. Findings that change the brief

1. **t3code does not run Claude Code over ACP.** Its Claude provider wraps the Claude Agent SDK directly (`apps/server/src/provider/Layers/ClaudeAdapter.ts`). ACP is used for Cursor, Grok, and Antigravity. The ACP *client* code is still the right thing to study; the Claude *agent* comes from `@agentclientprotocol/claude-agent-acp`. Details in BORROW.md §1.
2. **The Claude ACP adapter moved.** `@zed-industries/claude-code-acp` (0.16.2, last published March 2026) is superseded by `@agentclientprotocol/claude-agent-acp` 0.78.0 (Apache-2.0, ACP registry id `claude-acp`). Probe on this machine: `initialize` 159 ms, `session/new` ~700 ms (657 ms of it is the SDK boot), no `authenticate` needed (your Claude Max login is picked up), modes `default | acceptEdits | plan | auto | bypassPermissions`, prompt capabilities `image + embeddedContext`, `loadSession: true`.
3. **t3code's ACP layer is Effect-TS.** Porting files means adopting Effect. We port decisions and let the ACP SDK's `client()` / `ndJsonStream` / `ActiveSession` do the wire layer.
4. **The Lovable data model differs from the brief's schema** in six places (kind vs type, label vs name, x/y layout, per-graph drill-down, groups, inline code). CONTRACTS.md §1.3 resolves each; the Lovable prompts in §5 apply them.
5. **The Lovable app is SSR (nitro), not static.** "Serve the built viewer as static files" needs SPA build mode (prompt L6) or, as fallback, the viewer dev server pointed at the daemon with `?daemon=`.
6. **Node 20 is too old**: the adapter requires Node 22+. Daemon targets Node 22.
7. **Nothing in the UI is wired to a backend today.** Copy-path, pin, search, repo picker, "Open in repo", import/export, share-by-URL are decorative or absent. Inventory in §1.3.

## 1. Inventory of the Lovable viewer

### 1.1 Data shape it consumes (`src/data/graphs.ts`)

- `NodeKind = service | database | queue | external | frontend | gateway | module | file | step` (styled in `src/components/explorer/kinds.ts`, icons from lucide, colour tokens `--node-*`).
- `DiagramNode { id, label, subtitle?, kind, x, y, w?, h?, drill?, description?, owner?, tech?, endpoints?, health?, files?: CodeFile[] }` — `CodeFile { repo, branch, path, lang, code, highlight?, deps? }` carries inline source.
- `DiagramEdge { from, to, label?, animated? }`, `DiagramGroup { id, label, x, y, w, h }`.
- `Graph { id, title, subtitle, nodes, edges, groups? }`; `graphs: Record<string, Graph>` with five graphs (`system`, `backend-internals`, `frontend-internals`, `routes-module`, `frontend-module`, `workflow-jira`, `workflow-request`); drill-down = `node.drill` pointing at another graph id.
- `architectureRoots[]`, `workflowRoots[]` (sidebar lists), `repoTree[]` (hard-coded, leafs map to `graphId + nodeId`).
- Node size constants `NODE_W = 200`, `NODE_H = 64`; canvas world is fixed `1220 × 600`.

### 1.2 Components (`src/components/explorer/`)

| File | Role | State |
| --- | --- | --- |
| `DiagramCanvas.tsx` | pan/zoom (transform state, ⌘+wheel), hover-connected highlighting, popover + AgentBubble anchoring, zoom controls, Minimap | works; canvas world size hard-coded |
| `DiagramNode.tsx`, `DiagramEdge.tsx` | absolutely positioned button per node; SVG cubic edge with label pill and `edge-flow` dash animation | works |
| `NodePopover.tsx` | Drill in / Open code / Ask agent / Copy path / Pin | Copy path and Pin are no-ops |
| `AgentBubble.tsx` | floating composer anchored to the node, context chip `@path`, three suggestion buttons | works; submits to `ask()` |
| `InspectorPanel.tsx` | tabs Details / Code / Agent; Agent tab = thread of `ChatMessage { id, role, text, context? }` + Textarea composer | works; replies are canned (`replyFor()` in `routes/index.tsx`) |
| `CodePreview.tsx` | line-numbered code with a naive tokenizer, highlight range, imports badges | works on inline `code` only; "repo" link is `href="#"` |
| `RepoTree.tsx`, `LayerBreadcrumb.tsx`, `ModeToggle.tsx`, `Minimap.tsx` | sidebar tree, breadcrumb over the graph stack, Architecture/Workflows toggle, minimap | work on hard-coded data |
| `routes/index.tsx` | all state (`mode`, `stack`, `selectedId`, `tab`, `thread`, panel toggles) in `useState`; desktop 3-pane layout (18 % / 56 % / 26 %) + mobile Sheet layout | works |

Missing entirely: import/export, share-by-URL, search (button only), repo picker (button only), copy-as-prompt, any network code, any store.

### 1.3 Design tokens (from `src/styles.css`, all oklch)

- Surfaces: `--background 0.095`, `--canvas 0.105`, `--surface-1 0.125`, `--surface-2 0.165`, `--surface-3 0.215`, `--hairline 0.265` (hue 205, chroma ≤ 0.01).
- Accent: `--primary` / `--ring` / `--edge-active` = cyan `oklch(0.76 0.105 198)`; `--primary-foreground 0.13`.
- Status: `--ok` green (0.75 0.13 150), `--warn` amber (0.8 0.14 85), `--bad` red (0.65 0.2 22), `--destructive`.
- Node tints: `--node-service` blue 250, `--node-data` green 150, `--node-queue` amber 85, `--node-external` grey 265, `--node-frontend` magenta 320, `--node-file` cyan 195, `--node-gateway` orange 30, `--node-step` violet 265.
- Type: body DM Sans 13 px; display Space Grotesk (13–14 px, weight 500–600); mono JetBrains Mono for paths, code, chips. UI sizes 9.5–12.5 px. Labels uppercase 9.5 px semibold muted.
- Shape: `--radius 0.375rem`; inner elements `rounded-[4px]`; hairline borders; utilities `panel-glass`, `control-glass` (surface-2 + soft shadow), `node-elevated`, `grid-canvas` (dot grid 24 px), `edge-flow`.
- Motion: 100–150 ms colour/transform transitions; `animate-in fade-in-0`; reduced-motion respected.
- Layout: header `h-12`; inspector header `h-14`; tabs `h-9` with bottom-border active state; sections `px-4 py-4` separated by `Separator`; composer = `Textarea` (surface-2, mono 11.5 px) + `Button size="sm" h-6`.

The agent panel additions in §5 reuse exactly these: tool rows use `--node-file` (read), `--warn` (edit pending), `--ok` (completed), `--bad` (failed); diffs use `bg-ok/10` and `bg-bad/10` line backgrounds; permission card uses `control-glass` with `border-primary/40`.

### 1.4 What the daemon must provide because of the UI

Today: nothing (no fetches). After the §5 prompts: WebSocket at `/ws`, `GET /api/file`, `GET /api/context/:nodeId`, SPA fallback for `/`, `Origin` allowance for the Lovable preview host during development.

## 2. Target architecture

```
                 Lovable viewer (static build or bun dev + ?daemon=)
                 ──────────────────────────────────────────────────
                          │  WebSocket /ws  (CONTRACTS §2)      │ GET /api/file, /api/context
                          ▼                                     ▼
  ┌───────────────────────────────── archmap serve (Node 22, 127.0.0.1:4177) ───────────────────────────────┐
  │ serve/server.ts ── static.ts ── session.ts (per-socket state machine, one active turn)                  │
  │ serve/architecture-store.ts  (load → validate → layout → watch → revision → broadcast)                   │
  │ context/pack.ts  (CONTRACTS §3)      context/graph.ts (indexes: incoming/outgoing/children/workflows)    │
  │ acp/bridge.ts    (start / prompt / cancel / setMode / permission map / normalize → StreamEvent)          │
  │ acp/agent-process.ts (spawn preset, ndJsonStream, stderr ring, exit → respawn once)                      │
  │ acp/presets.ts   (claudeCode; codex later)                                                                │
  └────────────────────────────────────────────┬──────────────────────────────────────────────────────────────┘
                                               │ stdio, ndjson JSON-RPC, ACP v1
                                               ▼
                       node …/@agentclientprotocol/claude-agent-acp/dist/index.js  (cwd = repo root)
                                               │
                                               ▼
                                   Claude Code (bundled binary, your login)
```

### 2.1 Daemon repo layout (`archmap/`)

```
package.json          name archmap, type module, bin { archmap: dist/cli.js }, engines node >=22
src/cli.ts            node:util parseArgs → scan | serve | mcp
src/contracts/architecture.ts   zod schema + types (CONTRACTS §1)
src/contracts/ws.ts             zod schema + types (CONTRACTS §2)
src/context/graph.ts            ArchIndex: byId, incoming, outgoing, children, workflowsOf, relPath/absPath
src/context/pack.ts             buildContextPack(index, nodeId, root) → string (CONTRACTS §3), buildPromptBlocks()
src/acp/presets.ts              { claudeCode: { command, args, env } }
src/acp/agent-process.ts        spawn, ndJsonStream(Writable.toWeb(stdin), Readable.toWeb(stdout)), stderr ring, exit
src/acp/bridge.ts               AcpBridge (see 2.2)
src/acp/normalize.ts            SessionUpdate → StreamEvent, tool-call merge map, path relativizing, output cap
src/serve/server.ts             http.createServer + ws upgrade + Origin check
src/serve/static.ts             SPA static serving with mime map, immutable assets
src/serve/session.ts            hello → ready; prompt/cancel/permission routing; broadcast
src/serve/architecture-store.ts load/validate/layout/watch (fs.watch + 250 ms debounce)/revision
src/serve/mock.ts               --mock: scripted turn for UI development without an agent
src/scan/index.ts               scanRepo(root, opts) → Architecture
src/scan/detectors/{workspaces,manifests,entrypoints,compose,imports}.ts
src/scan/layout.ts              deterministic layered layout (fills x/y)
src/scan/describe.ts            --describe via AcpBridge with read-only permission policy
src/mcp/server.ts               Phase 3: get_architecture, get_node, get_focus
viewer/                         built viewer (copied from Lovable `bun run build` output); overridable with --viewer <dir>
test/fake-agent.ts              scripted ACP agent (SDK agent()) for bridge tests
test/*.test.ts                  vitest
```

Dependencies (exact pins): `@agentclientprotocol/sdk@1.4.0`, `@agentclientprotocol/claude-agent-acp@0.78.0`, `ws@8`, `zod@3`. Dev: `typescript`, `tsx`, `tsup`, `vitest`. Phase 3 adds `@modelcontextprotocol/sdk`. No framework, no Effect, no CLI library (`node:util.parseArgs`), no file-watcher library (`fs.watch`).

### 2.2 `AcpBridge` (the core of Phase 1)

```ts
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { createRequire } from "node:module";
import { client, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const entry = createRequire(import.meta.url).resolve("@agentclientprotocol/claude-agent-acp/dist/index.js");
const child = spawn(process.execPath, [entry], { cwd: root, stdio: ["pipe", "pipe", "pipe"], env: presetEnv });
const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));

const app = client({ name: "archmap" })
  .onRequest("session/request_permission", ({ params, signal }) => permissions.ask(params, signal)); // returns RequestPermissionResponse
const conn = app.connect(stream);                                   // long-lived; conn.closed resolves on exit

await conn.agent.request("initialize", {
  protocolVersion: PROTOCOL_VERSION,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: "archmap", version },
});
const session = await conn.agent.buildSession(root).start();        // ActiveSession; modes in session.modes

// per turn
const done = session.prompt(blocks);                                 // blocks from context/pack.ts §3.3
for (;;) {
  const m = await session.nextUpdate();
  if (m.kind === "stop") break;                                      // m.stopReason
  for (const ev of normalize(m.update)) emit(ev);                    // StreamEvent[]
}

// cancel
permissions.cancelAll(turnId);                                       // respond {outcome:"cancelled"} first
await conn.agent.notify("session/cancel", { sessionId: session.sessionId });
await withTimeout(done, 15_000).catch(killAndRespawn);
```

Guard rails from BORROW.md §2.2: one active turn; ignore updates for other session ids and `_meta.isReplay`; ignore unknown `_`-prefixed methods; kill-and-respawn on cancel timeout; fail pending permissions on exit.

### 2.3 Latency budget for the demo

| Step | Target | How |
| --- | --- | --- |
| Page load → diagram | < 100 ms after WS open | daemon sends `architecture` immediately after `hello` |
| `archmap serve` start → agent idle | ~1.5 s, before the user clicks anything | spawn + initialize + session/new at startup, not on first prompt |
| Click node → composer | 0 | UI only |
| Send → `turn.started` | < 20 ms | context pack is built from an in-memory index |
| Send → first `stream.text` or `stream.tool_call` | 1–3 s (model bound) | prompt sent as one `session/prompt`; `resource_link` blocks so Claude opens files without a search round-trip |
| Cancel → `turn.finished` | < 2 s typical, 15 s worst | `session/cancel` |

## 3. Phases

Effort = dev-days for one engineer driving coding agents.

### Phase 0 — Spike (0.5 d)

Deliverable: `scripts/spike-acp.ts` in the new repo. Spawns the adapter, initialize, session/new, sends "List the files under src/ and stop", prints every `session/update` with timestamps, then sends a prompt that requires an edit in `default` mode and answers the permission request from stdin, then cancels a long prompt.

Exit criteria (all measured, written into the README):
- text chunks stream; a `tool_call{kind:"read"}` appears with `locations[]`.
- a `session/request_permission` arrives for the edit; answering `allow_once` produces a `tool_call_update` with a `diff` content block.
- `session/cancel` returns `stopReason: "cancelled"` within 2 s.
- `ActiveSession.nextUpdate()` receives updates; note whether a global `session/update` handler duplicates them (ASSUMPTIONS 12).
- `_auth/status_update` and `available_commands_update` do not crash the client.

### Phase 1 — Core loop demo (5 d) → Milestone M1

Ends with the screen recording in §4.

| # | Task | Est. | Depends on |
| --- | --- | --- | --- |
| 1.1 | Repo scaffold, `contracts/*.ts` from CONTRACTS.md, vitest, tsup | 0.5 | — |
| 1.2 | `acp/agent-process.ts` + `acp/bridge.ts` + `acp/normalize.ts` with `test/fake-agent.ts` covering: text turn, read tool, edit + permission, cancel, crash mid-turn | 1.5 | 0 |
| 1.3 | `context/graph.ts` + `context/pack.ts` with golden-file tests (the §3.4 example in CONTRACTS.md is the first golden) | 0.5 | 1.1 |
| 1.4 | `serve/*`: http + ws + Origin check, static SPA serving, `architecture-store` with validation/layout/watch, `session.ts` turn state machine, `/api/file`, `/api/context/:id`, `--mock` | 1.5 | 1.1, 1.3 |
| 1.5 | Lovable prompts L1–L6 applied, iterated against `--mock`, then against the real agent | 1 | 1.4 |
| 1.6 | Hand-written `architecture.json` for the demo repo; rehearse; record | 0.5 | 1.5 |

Definition of done: `archmap serve <repo>` opens the viewer; clicking `invoices-api`, typing one line, and pressing Enter streams Claude's read tool calls on the node's files within 3 s; an edit shows the permission card; Allow shows the diff; Stop cancels; killing the adapter process mid-turn yields `agent.status{error}` and the daemon recovers on the next prompt.

### Phase 2 — `archmap scan` (3 d) → Milestone M2

| # | Task | Est. |
| --- | --- | --- |
| 2.1 | Walker with ignore rules (`.gitignore` via `git ls-files` when available, else built-in list), size/count caps (5,000 files, 2 MiB per file) | 0.5 |
| 2.2 | Detectors: workspaces (pnpm/npm/yarn, Cargo, go.work), manifests (`package.json` deps → `tech`, framework → `type`), entrypoints (`main`, `bin`, `scripts.start`, `src/index|main|app|server.*`, `routes/`, `api/`), docker-compose (`services` → nodes by image: postgres/mysql/mongo → datastore, redis/kafka/rabbitmq/sqs → queue; `depends_on` → edges), imports (relative imports between workspace packages and between top-level `src/` dirs → edges, capped) | 1.5 |
| 2.3 | `layout.ts`: layers = top-level dirs; columns by type (frontend/external → left, gateway → 1, service/module → 2, datastore/queue → right); grid 260 × 110 px; stable ordering by id | 0.5 |
| 2.4 | `--describe`: one prompt listing all nodes with paths, asks for `{ "<id>": "<2 sentences>" }`, read-only auto-permission policy (allow `read/search/think`, reject the rest), 3-minute timeout, writes descriptions back only for ids that exist | 0.5 |

Definition of done: `archmap scan t3code/` produces ≥ 12 nodes (apps/*, packages/*), edges from workspace deps, three layers, and validates; `archmap scan "Architect's Canvas/"` produces module nodes for `src/components`, `src/routes`, `src/data`, `src/lib` with import edges.

### Phase 3 — Hardening and extras (3 d) → Milestone M3

- Reconnect replay: ring buffer of the last turn's frames; a reconnecting viewer receives them after `hello`.
- `architecture.save` / `PUT /api/architecture` with atomic write; the Details tab edits `notes` and `description` (prompt L7).
- Mode selector (`mode.set` → `session/set_mode`), `session.reset`, `--mode` and `--yolo` flags.
- `archmap mcp`: stdio MCP server exposing `get_architecture`, `get_node(id)`, `get_focus`; also passed to the agent via `session/new.mcpServers` when `--mcp` is set, so Claude can query the map itself.
  Done 2026-09-23, wider than planned: read **and write** tools (`ruah_get_architecture`, `ruah_get_element`, `ruah_find_elements`, `ruah_add/update/remove_element`, `ruah_connect/disconnect`, `ruah_add/update_workflow`, `ruah_apply`), always on (no `--mcp`), in-process for Claude and `archmap mcp --daemon <url>` for ACP agents — CONTRACTS §1.7, `src/mcp/*`.
- Packaging: `npm i -g archmap` / `npx archmap`; viewer build copied into `viewer/` by a `sync-viewer` script from a Lovable export path.
- Tool-update coalescing if the viewer stutters (BORROW.md §2.3).
- Tests: bridge against the fake agent, pack goldens, store validation, one end-to-end test with `--mock`.

### Phase 4 — Optional (3 d+)

Codex via `codex-acp` (registry id `codex-acp`) as a second preset with `--agent codex`; export/import/share-by-URL in the viewer (prompt L8); per-node threads; branching workflow transitions; self-hosted fonts.

### 3.5 Work packages (hand each to a different model with only the listed inputs)

| WP | Scope (files) | Inputs to give the model | Acceptance check | Depends on |
| --- | --- | --- | --- | --- |
| A — ACP bridge | `src/acp/*`, `test/fake-agent.ts`, `test/bridge.test.ts`, `scripts/spike-acp.ts` | CONTRACTS.md §2.1 (`StreamEvent`, `ToolCallView`, `PermissionOption`), §2.2 rules 4–5, §2.5, §3.3; BORROW.md §2.1–2.5 | fake-agent suite green (text, read tool, edit + permission, cancel, crash); spike numbers recorded in README | nothing; publishes the `AcpBridge` interface first (`start/prompt/cancel/setMode/onUpdate/onPermission/onTerminated/status`) |
| B — Server, store, context pack | `src/contracts/*`, `src/context/*`, `src/serve/*`, `src/cli.ts` (serve only) | CONTRACTS.md §1, §2, §3 in full; PLAN.md §2.1–2.3 | `archmap serve --mock` drives a scripted turn end-to-end over WS; pack golden tests (§3.4 example first); validation tests for §1.2 rules 1–7 | the `AcpBridge` interface from A (stub is enough to start) |
| C — Viewer | Lovable prompts L1–L6 (Phase 1), L7 (Phase 3), L8 (Phase 4) | CONTRACTS.md §1.3, §2.1–2.4; PLAN.md §1.3, §5 | demo script §4 passes against `--mock`, then against the real agent | B for `--mock`; A+B for the real run |
| D — Scanner | `src/scan/*`, `src/cli.ts` (scan) | CONTRACTS.md §1; PLAN.md Phase 2 table; ASSUMPTIONS.md 22–23 | `archmap scan t3code/` and `archmap scan "Architect's Canvas/"` produce valid files with the expected node counts; `--describe` fills descriptions on one of them | B (contracts + validator); A for `--describe` |
| E — MCP + packaging | `src/mcp/*`, `scripts/sync-viewer.ts`, npm publish config, `THIRD_PARTY_NOTICES.md` | PLAN.md Phase 3; BORROW.md §2.4 (mcpServers row) and §3 | `archmap mcp` answers `get_architecture`/`get_node`; `npx archmap serve` works from a clean directory | B |

Handoff rules: every package receives CONTRACTS.md whole plus only its BORROW.md rows; no package reads another package's code; interface changes go through CONTRACTS.md first and are announced in its top-of-file changelog (add one when the first change happens).

## 4. Demo script (M1)

1. Terminal: `archmap serve ~/code/acme-platform` → prints `viewer http://127.0.0.1:4177  agent claude-agent-acp 0.78.0 idle (1.4 s)`.
2. Browser: diagram renders; header shows `acme-platform` with a green dot (agent idle).
3. Click `invoices-api` → popover → **Ask agent** → type `there might be a bug in how invoices are validated` → Enter.
4. Agent tab: the user bubble shows the context chip `@services/invoices-api`; "context ▸" expands the exact pack. Within ~2 s tool rows appear: `Read invoices.routes.ts`, `Read invoices.service.ts` (cyan icons, paths clickable → Code tab). Text streams.
5. Claude proposes an edit → permission card: **Allow** / **Always allow edits** / **Reject** → click Allow → diff block with the changed line highlighted.
6. Turn footer: `end_turn`. Click **Stop** on a second prompt to show cancel.

## 5. Lovable prompts

Paste each into Lovable in order. Each is self-contained and names the files it touches. Keep CONTRACTS.md open; where a prompt says "the `Architecture` type" or "the WS message types", paste the TypeScript from CONTRACTS.md §1.1 or §2.1 into the prompt after the text.

**L1 — Data model + mapper (no visual change)**

> Add `src/lib/contracts.ts` containing exactly these TypeScript types: [paste CONTRACTS.md §1.1 and §2.1]. Add `src/lib/architecture.ts` exporting `toGraph(arch: Architecture, parentId: string | null): Graph`, `toRepoTree(arch): RepoTreeNode[]`, and `workflowGraph(arch, workflowId): Graph`, producing the existing `Graph`, `DiagramNode`, `DiagramEdge`, `DiagramGroup` types from `src/data/graphs.ts`. Mapping rules: `type` → `kind` with `datastore` → `database` and unknown types → `module`; `name` → `label`; `subtitle` = first two `tech` joined by " · ", else `path`; a node is shown at level `parentId` when `node.parent === parentId` (root = nodes with no parent); `drill` is set to the node's own id when it has children; edges are included only when both ends are visible; `groups` = one per `layer` present at this level, box = bounding box of its nodes plus 24 px padding, label = layer name; `edge.animated` = kind is `async` or `event`; `x`/`y` come from the node (default 0). `workflowGraph` lays the step nodes left-to-right (260 px apart, wrapping every 4) and creates sequential edges. `toRepoTree` builds a directory tree from every `path` and `files[]` entry, leafs carrying `nodeId`. Move the current sample data into `src/data/sample-architecture.json` in the new `Architecture` shape (convert the `system` and `backend-internals` graphs: backend-internals nodes get `parent: "api"`; the Jira workflow becomes `workflows[0]` with `type: "step"` nodes) and delete the other sample graphs. Keep every component's behaviour identical when rendering the sample.

**L2 — Daemon connection + store**

> Add `src/lib/daemon.ts`: a WebSocket client using the message types in `src/lib/contracts.ts`. URL = the `daemon` query parameter if present (e.g. `?daemon=ws://127.0.0.1:4177/ws`), else `ws(s)://${location.host}/ws`. On open send `{"type":"hello","protocol":1,"client":"architects-canvas/0.1.0"}`. Reconnect with exponential backoff (500 ms → 8 s). Expose a store via `useSyncExternalStore` with: `connection: "connecting"|"open"|"closed"`, `architecture: Architecture | null`, `root: string | null`, `agent: AgentStatus | null`, `turns: Turn[]` (each turn: id, nodeId, text, contextPack, events: StreamEvent[], permission: PermissionRequest | null, stopReason?), and actions `sendPrompt(nodeId, text)`, `cancel(turnId)`, `answerPermission(requestId, optionId | "cancel")`, `setFocus(nodeId)`. When no daemon is reachable after the first attempt, fall back to `sample-architecture.json` and mark `connection: "closed"`. In `routes/index.tsx` replace the `graphs`/`architectureRoots`/`workflowRoots`/`repoTree` imports with data from the store through `toGraph`/`toRepoTree`/`workflowGraph`; the breadcrumb stack now holds node ids (root = `null`) and shows node names; the Architecture/Workflows toggle lists workflows from `architecture.workflows`. Replace the decorative `acme/platform · main` header button with the architecture `name` and a 6 px status dot (`bg-ok` when agent idle, `bg-warn` busy, `bg-bad` error or disconnected) with a tooltip showing agent name/version and connection state. Call `setFocus` whenever `selectedId` changes.

**L3 — Streaming Agent tab**

> Replace the canned `replyFor()` and the `ChatMessage` thread in `InspectorPanel.tsx` with rendering of `turns` from the daemon store. `ask()` in `routes/index.tsx` now calls `sendPrompt(node.id, text)`. Per turn render, in order: (1) the user bubble with the existing `@path` context badge plus a collapsed "context ▸" disclosure that shows `contextPack` in a mono 10.5 px block on `bg-surface-2`; (2) events: `text` chunks appended into the current assistant paragraph (a `tool_call` event starts a new paragraph after it); `thought` rendered as muted italic 11 px, collapsed by default under "thinking ▸"; `tool_call`/`tool_result` upserted by `toolCallId` into a compact row: lucide icon by kind (`read` FileCode2, `edit` Pencil, `delete` Trash2, `move` MoveRight, `search` Search, `execute` Terminal, `think` Brain, `fetch` Globe, other Wrench), title, first location path in mono `text-primary` (click → select the owning node if any node's `files` or `path` matches, and open the Code tab), status dot `bg-muted-foreground` pending, `bg-warn` in_progress, `bg-ok` completed, `bg-bad` failed, and a "output ▸" disclosure when `output` exists; `diff` rendered with the `CodePreview` styling: file header, then `oldText` lines with `bg-bad/10` and a `-` gutter, `newText` lines with `bg-ok/10` and a `+` gutter; `plan` as a checklist. (3) footer line in mono 10 px: `end_turn` muted, `cancelled` warn, `refusal`/`error` bad. While the latest turn has no `stopReason`, show a blinking 1-ch cursor at the end of the assistant text, disable the composer, and turn the Send button into **Stop** (calls `cancel`). Keep the `AgentBubble` suggestions. Add "Copy context" to `NodePopover.tsx` (replacing "Copy path") that fetches `GET {daemonHttpOrigin}/api/context/{nodeId}` and copies the text; keep "Pin" removed.

**L4 — Permission card**

> When a turn has a pending `permission`, render a card pinned above the composer in the Agent tab (and, if the `AgentBubble` is open, inside it) using the `control-glass` utility with `border-primary/40`: header row "Permission needed" in uppercase 9.5 px muted with a ShieldAlert icon in `text-primary`; the tool row from L3 for `permission.toolCall`; then one button per `options[]` entry in the order received: `allow_*` kinds as `Button size="sm"` primary, `reject_*` as `variant="outline"`, labels = `option.name`. Enter triggers the first `allow_once` option, Escape sends `answerPermission(requestId, "cancel")`. After answering, the card collapses into a one-line record inside the turn ("allowed: Edit invoices.routes.ts").

**L5 — Code tab from the daemon**

> In `InspectorPanel.tsx` Code tab: when the selected node has `files`, show a small `Select` over them (default first) and fetch `GET {daemonHttpOrigin}/api/file?path=<encoded>`, rendering the result with `CodePreview` by constructing a `CodeFile { repo: architecture.name, branch: "", path, lang, code }`. Show a skeleton while loading and the existing empty state on 404. Make "Open in repo" a real link to `vscode://file/${root}/${path}` (root from the store). When a node has `path` but no `files` and the path is a file, treat it as the single file.

**L6 — Static build**

> Configure the project so `bun run build` produces a static single-page build that any file server can host: enable TanStack Start SPA mode in `vite.config.ts` through `defineConfig({ tanstackStart: { spa: { enabled: true, prerender: { outputPath: "/index.html" } } } })` (keep the existing `server.entry` setting), make sure no route uses server functions or loaders that require SSR, and confirm the output directory contains `index.html` and an `assets/` folder. Tell me the output directory path.

**L7 — Phase 3: editing + modes**

> Details tab: make `description` and `notes` editable inline (click to edit, blur or ⌘⏎ to save) and send `{"type":"architecture.save"}` with the updated architecture; disable while the daemon is disconnected. Agent tab header: add a `Select` with `agent.modes.available` (label = `name`, tooltip = `description`) that sends `{"type":"mode.set","modeId"}`; add a "New session" ghost button sending `{"type":"session.reset"}` with a confirm dialog.

**L8 — Phase 4: import/export/share**

> Header menu with Export (downloads `architecture.json`), Import (file picker → `architecture.save`), and Share (copies a URL with `#a=<base64url-gzipped architecture>`; on load, if the hash is present and no daemon is connected, render it read-only).

## 6. Risks and de-risking

| Risk | Impact | De-risk (when) |
| --- | --- | --- |
| ACP protocol drift (SDK 1.x moves fast; `ClientSideConnection` already deprecated in favour of `client()`; v2 experimental in the same package) | bridge breaks on upgrade | Pin exact versions. Commit `schema/schema.json` from the SDK into `contracts/acp-schema.json` and diff it in CI on upgrades. Bridge talks to the SDK through one file (`acp/bridge.ts`); the fake agent test suite is the upgrade gate. (Phase 1.2) |
| Claude adapter availability / breakage (0.78.0 today, preview builds on every push; registry metadata says "proprietary" while the package is Apache-2.0) | no agent for the demo | Pin `0.78.0`. Keep `CLAUDE_CODE_EXECUTABLE` passthrough so the adapter uses your installed CLI if the bundled one misbehaves. Fallback preset in Phase 4: a thin bridge over `@anthropic-ai/claude-agent-sdk` `query()` (the t3code approach) behind the same `AcpBridge` interface. (Phase 0 proves the adapter; fallback only if Phase 0 fails.) |
| Permission UX: option ids are agent-defined, requests can outlive the turn, cancel must answer pending requests | agent hangs or UI shows dead buttons | Relay `options[]` verbatim; `permission.resolved` echo; cancel answers pending requests before `session/cancel`; unknown request id → `error{no_turn}`; 15 s cancel timeout then respawn. Tested with the fake agent. (Phase 1.2) |
| Lovable limits: SSR build, no store, no network code, design regressions when adding panels | viewer cannot be served statically; UI drifts | `--mock` mode so UI work never waits on the agent; `?daemon=` so `bun run dev` is a valid demo path if L6 fails; prompts reference tokens and components by name and forbid new colours. (Phase 1.4–1.5) |
| Time to first token feels slow on camera | demo looks sluggish | Session pre-created at startup; `resource_link` blocks; text chunks forwarded unbatched; spike measures real numbers and the demo prompt is chosen so Claude reads the listed files first. (Phase 0, 1.6) |
| Scanner produces a useless map on real repos | M2 is a toy | Two real targets in the definition of done (`t3code`, the Lovable export); `--describe` fills descriptions; hand-editing is supported and preserved by the store (Phase 2, 3). |
| Viewer disconnect mid-turn loses the turn | annoying during development | Phase 1 cancels (simple); Phase 3 replays. |
| Mixed content or Origin problems between a Lovable preview and the local daemon | cannot test from Lovable | `--allow-origin` glob; loopback is treated as secure by Chromium/Firefox; fallback is local `bun run dev`. |
| Node version mismatch (adapter needs 22+) | spawn fails on older machines | `engines` + a startup check that prints the requirement. |

## 7. Decisions taken (change any of these before Phase 1 starts)

1. Agent = `@agentclientprotocol/claude-agent-acp@0.78.0` spawned as a dependency with `process.execPath`, not `npx`.
2. One agent process, one session, one turn at a time; session persists across prompts.
3. No `fs`/`terminal` client capabilities in Phase 1.
4. Default mode `default` (ask before changes); `--mode` and `--yolo` flags in Phase 3.
5. Daemon fills `x`/`y`; the viewer never lays out.
6. Drill-down via `parent`; workflows are ordered step lists.
7. Viewer disconnect cancels the turn (Phase 1).
8. Demo uses a hand-written `architecture.json`; the scanner is Phase 2.
9. MIT attribution for adapted t3code logic via `THIRD_PARTY_NOTICES.md` + file headers.
