# Design patterns and decisions behind Ruah

A teaching document. It walks through the system design patterns used to build
Ruah, using its real code as the worked example: what problem each pattern
solved, why it was chosen here, what it costs, and when you should not use it.

Ruah is the product name; the repository and CLI are still called `archmap`.
Ruah is a local daemon plus a desktop/web viewer. It scans repositories into
architecture maps, drives coding agents (Claude Agent SDK and ACP agents such as
Cursor, Grok, Kiro, OpenCode) with the selected part of the map as context,
connects to cloud and issue trackers, and federates several repos into one
system map.

Sources: `docs/DESIGN-NOTES.md` (notes taken during the build),
`docs/CONTRACTS.md`, `docs/PLAN.md`, `docs/MULTI-REPO.md`, `docs/ASSUMPTIONS.md`,
`docs/BORROW.md`, `THIRD_PARTY_NOTICES.md`, the code under `src/`, `electron/`,
`ui/src/lib/`, and `git log`. Every file path and symbol below exists in the
repository as of this writing.

Code excerpts are real but trimmed; `// …` marks an elision and comments
starting with `// ←` are annotations added for this document.

How to read it: section 1 gives the whole picture on one page. Section 2 is the
catalogue; each entry stands alone, so skim the titles and read what you need.
Section 3 is the bugs we shipped and what they teach. Section 4 turns it all into
a checklist you can apply to your own system.

Contents

1. [One-page overview](#1-one-page-overview)
2. [Pattern catalogue](#2-pattern-catalogue)
   - [A. Architecture style](#a-architecture-style) (1–4)
   - [B. Integration](#b-integration) (5–12)
   - [C. Communication and concurrency](#c-communication-and-concurrency) (13–19)
   - [D. Data and state](#d-data-and-state) (20–30)
   - [E. Security](#e-security) (31–37)
   - [F. AI and context engineering](#f-ai-and-context-engineering) (38–41)
   - [G. Scale and performance](#g-scale-and-performance) (42–44)
   - [H. Process: building with AI agents](#h-process-building-with-ai-agents) (45–47)
3. [Anti-patterns we hit and fixed](#3-anti-patterns-we-hit-and-fixed)
4. [How to apply this to your own system](#4-how-to-apply-this-to-your-own-system)
5. [Glossary](#5-glossary) and [further reading](#6-further-reading)

---

## 1. One-page overview

```
 ┌───────────────────────── Viewer (thin client, static SPA) ─────────────────────────┐
 │ ui/src/lib/daemon.ts (WS store)  architecture.ts (toGraph…)  integrations.ts  usage │
 │ hosted by Electron (electron/main.cjs), a plain browser, or a Lovable preview       │
 └─────────────┬─────────────────────────────────────────┬─────────────────────────────┘
               │ WebSocket /ws  (push: stream, status)   │ HTTP /api/*  (request/response)
               ▼                                         ▼
 ┌──────────────── archmap daemon  (Node 22, 127.0.0.1:4177, src/serve/*) ──────────────┐
 │ server.ts ── Origin check ── SessionHub (session.ts): open project, one active turn │
 │   │                            │                                                     │
 │   │ ArchitectureStore          │ BridgePool (warm agents, TTL + LRU)                 │
 │   │ (file + watch + validate)  │ AgentCatalog (factory over presets)                 │
 │ ProjectService  ChatStore  UsageService  IntegrationsService → IntegrationRegistry  │
 │ context/pack.ts (context pack)   scan/* (repo → map)   system/* (repos → system)    │
 └──────┬───────────────────────┬───────────────────────────┬─────────────────┬────────┘
        │ AcpBridge interface   │ filesystem                │ execFile (no    │ HTTPS
        ▼                       ▼                           │ shell)          ▼
 ClaudeSdkBridge ─ SDK query()  <repo>/architecture.json    ▼            Jira REST v3
 AcpProcessBridge ─ ACP stdio   <repo>/.ruah/links.json   doctl, aws,   (token in
 MockBridge ─ scripted          ruah.system.json          gh, ruah,     macOS Keychain)
        │                       ~/.ruah/ projects, chats, security
        ▼                       usage.jsonl, integrations.json
 Claude Code · Cursor · Grok · Kiro · OpenCode   (run in the repo, with the user's login)
```

### The five decisions that shaped everything

| # | Decision | Consequence you see everywhere |
| --- | --- | --- |
| 1 | **The agent runs where the code is.** A local daemon owns the repo, the agent processes and the user's logins; the UI is a thin, static client. | No cloud backend, no uploaded code, no stored API keys. One extra process and localhost security to get right. |
| 2 | **Contracts first.** `docs/CONTRACTS.md` is the only coupling between viewer and daemon; zod schemas in `src/contracts/*` enforce it at the daemon boundary. | Humans, Lovable and several AI agents built parts in parallel without reading each other's code. Types exist twice (daemon and viewer). |
| 3 | **One agent interface, many agents.** `AcpBridge` hides whether the agent is the Claude Agent SDK, any ACP agent, or a mock. ACP is the standard; the Claude SDK is the one deliberate exception. | Adding an agent is a preset. Tests never need a paid model. Provider extras need escape hatches. |
| 4 | **The map is a file in the repo.** `architecture.json` is the source of truth; diagrams, context packs, system maps and cloud views are derived from it. | Diffable, reviewable, editable by hand, by the UI and by agents. Every writer must validate and merge instead of overwrite. |
| 5 | **Humans stay in the loop.** Agent tool use asks for permission, AI suggestions are proposals, integrations are read-only unless the user confirms a write. | Safe defaults; a little more clicking. The system never silently changes code, the map, or a tracker. |

---

## 2. Pattern catalogue

Every entry uses the same template:
**Problem** · **Pattern** · **Where in Ruah** · **Why here** · **Rejected** ·
**Costs** · **Not when** · **Try it**.

---

### A. Architecture style

#### 1. Local-first daemon + thin client

- **Problem.** A coding agent needs the repo on disk, the user's git, and the user's Claude/Cursor login. A browser tab has none of these. We also wanted the same UI in Electron, a normal browser and a Lovable preview.
- **Pattern.** *Local-first client/server*: a long-running local process (daemon) owns all state and side effects; the UI is a static bundle that talks to it over localhost. Also called a *sidecar* when the desktop shell spawns it.
- **Where in Ruah.** Daemon: `src/serve/run-serve.ts` (`runServe`), `src/serve/server.ts` (`startServer`), bound to `127.0.0.1:4177`. Viewer: `ui/` built to static files and served by `src/serve/static.ts` (`serveStatic`). Desktop: `electron/main.cjs` spawns `dist/cli.js serve` (`startDaemon`), polls `/api/health` (`waitForDaemon`), then loads `http://127.0.0.1:4177` in a window.
- **Why here.** Code, credentials and agents never leave the machine. The viewer stays a static bundle any shell can host. The daemon can also run headless (`archmap serve <repo>` in a terminal).
- **Rejected.** A cloud backend (latency, secrets, code leaving the machine). An Electron-only app with logic in the main process (no browser or Lovable path, and Node access next to the renderer).
- **Costs.** One more process to start, supervise and version. Localhost is not a security boundary by itself (see #34). Electron refuses to start if a leftover daemon already answers on the port (`healthOnce()` pre-check in `main()`).
- **Not when.** Multi-user collaboration on shared state, or data that must outlive one machine. Then you need a real server; local-first can still be the offline cache.
- **Try it.** Run `archmap serve --mock <repo>` and open the URL in a browser, then in Electron. Same bundle, same daemon. List which parts of your own app need the user's machine and which only need a screen.

#### 2. Contract-first design (one source of coupling)

- **Problem.** The daemon, the Lovable viewer, and several AI agents were built at the same time by different builders who could not read each other's code.
- **Pattern.** *Contract-first* (API-first): write the wire formats and rules before the code, and make the contract the only shared artefact. Related: *published language* (DDD).
- **Where in Ruah.** `docs/CONTRACTS.md` §1 (`architecture.json`), §2 (WebSocket + HTTP), §3 (context pack), §5 (projects/chats), §6 (integrations). Daemon side: zod schemas in `src/contracts/architecture.ts`, `ws.ts`, `projects.ts`, `integrations.ts`, `usage.ts`. Viewer side: the same types copied into `ui/src/lib/contracts.ts`.
- **Why here.** PLAN.md §3.5 hands each work package "CONTRACTS.md whole plus only its BORROW.md rows"; "no package reads another package's code". The contract is what makes that possible.
- **Rejected.** A shared npm package of types (the viewer lived in another tool, Lovable, that could not import it).
- **Costs.** The types exist twice and drift. They did: the viewer's id check rejected namespaced ids after the daemon accepted them (fixed in `02f6423`, see section 3). Every contract change must be made in three places: the doc, the zod schema, the viewer copy.
- **Not when.** One team, one repo, one language: share the types directly (or generate them from one schema) instead of copying.
- **Try it.** Pick one message in `src/contracts/ws.ts` and diff it against `ui/src/lib/contracts.ts`. Then write a script that generates the viewer types from the zod schemas (`z.infer` + a type printer) so drift becomes a build error.

Conventions in the contract carry a lot of weight for little cost: repo-relative POSIX paths, one id pattern, ISO timestamps, and "receivers ignore unknown fields and unknown `type`/`kind` values" (CONTRACTS.md preamble). The last rule is what lets old viewers survive new daemon messages.

#### 3. Parse at the boundary ("parse, don't validate")

- **Problem.** Data enters the daemon from the viewer, from files people edit by hand, from agents and from provider CLIs. Any of it can be malformed.
- **Pattern.** *Parse, don't validate*: at the edge, turn `unknown` into a typed value or reject it; inside, code works only with typed values. Also *validate at the trust boundary*.
- **Where in Ruah.** Every WebSocket frame: `attachSession` in `src/serve/session.ts` size-checks (1 MiB), `JSON.parse`s, then `ClientMessageSchema.safeParse` before anything else runs. Files: `validateArchitecture` in `src/contracts/validate.ts` runs the zod schema, then the semantic rules of CONTRACTS §1.2 (unique ids, references exist, acyclic parents, paths inside the repo, no self-edges). Chat headers: `ChatInfoSchema.safeParse` in `src/projects/chat-store.ts`. Agent JSON: `parseSuggestions` in `src/system/suggest.ts`.

```ts
// src/serve/session.ts (attachSession)
const result = ClientMessageSchema.safeParse(parsed);
if (!result.success) {
  hub.error(socket, "bad_message", `frame failed validation: ${result.error.issues[0]?.message ?? "unknown"}`);
  return;
}
const message = result.data; // ← typed from here on
```

- **Why here.** A local tool still receives input from a browser, from hand edits and from LLMs. One schema gives both the runtime check and the static type (`z.infer`).
- **Rejected.** Hand-written `typeof` checks spread through handlers (they drift from the types and miss cases).
- **Costs.** Schemas must stay open where the contract is open (`NodeTypeSchema = z.string()`, not an enum) or new values break old daemons. The viewer does **not** validate what the daemon sends (`ui/src/lib/daemon.ts` casts `JSON.parse(ev.data) as ServerMessage`); that is a deliberate trust asymmetry (the daemon is ours), but it means a daemon bug shows up as a UI bug.
- **Not when.** Hot inner loops between modules you own; parse once at the edge, not at every call.
- **Try it.** Send `{"type":"prompt"}` (no `turnId`) over `/ws` after `hello` and read the `bad_message` error. Then find one place in your own code that trusts `JSON.parse` output and put a schema in front of it.

#### 4. An explicit "nothing open" state (null object at the edges)

- **Problem.** The first version required a repo on the command line. The desktop app then had to show a blocking native folder picker before anything else, and switching projects meant restarting the daemon.
- **Pattern.** Model "no project" as a real, first-class state instead of an impossible one. A cousin of the *Null Object* pattern: callers get a defined answer instead of a crash.
- **Where in Ruah.** `SessionHub` holds `open: OpenProject | null` (`src/serve/session.ts`); `archmap serve` without `<repo>` starts in this launcher state. Everything project-bound answers one clear error: HTTP `409 { error: "no project open" }` (`NO_PROJECT_MESSAGE`, checked in `startServer`), WS `error{bad_message}`. After `hello` the viewer gets `project{null}` + `agent.status{stopped}` and shows the start screen.
- **Why here.** The app opens instantly on a start screen; health, projects, usage and integrations work without a repo.
- **Rejected.** Keeping "serve needs a repo" and restarting per project (seconds per switch, drops sockets and warm agents).
- **Costs.** Every project-dependent handler needs a null check. Missing one is a 500 instead of a 409.
- **Not when.** When the empty state has no useful behaviour; then fail fast at startup instead.
- **Try it.** `curl -s localhost:4177/api/architecture` against a daemon started without a repo. Then grep your own code for places where "no current X" is handled by throwing deep inside a handler.

---

### B. Integration

#### 5. Ports and Adapters for coding agents

- **Problem.** We wanted Claude Code, Cursor, Grok, Kiro and OpenCode, plus a mock for UI work, without the server or the UI knowing which one is running.
- **Pattern.** *Ports and Adapters* (Cockburn), also called *Hexagonal Architecture*: the core defines a port (an interface in its own terms); each external technology gets an adapter that implements it.
- **Where in Ruah.** The port is `AcpBridge` in `src/acp/bridge.ts`. Adapters: `ClaudeSdkBridge` (`src/acp/claude-sdk-bridge.ts`, Claude Agent SDK `query()`), `AcpProcessBridge` (`src/acp/acp-bridge.ts`, any ACP agent over stdio), `MockBridge` (`src/acp/mock-bridge.ts`). The only consumer is `SessionHub`.

```ts
// src/acp/bridge.ts (trimmed)
export interface AcpBridge {
  start(): Promise<void>;                                       // ← trimmed: reset(), stop() omitted
  status(): AgentState;
  prompt(turnId: string, blocks: ContentBlock[]): TurnHandle;  // throws BusyError while a turn is active
  cancel(turnId: string): Promise<void>;
  answerPermission(requestId: string, answer: { optionId: string } | { cancelled: true }): boolean;
  setMode(modeId: string): Promise<void>;
  setModel(modelId: string): Promise<void>;
  on(listener: (event: BridgeEvent) => void): () => void;       // returns unsubscribe
  useSession?(sessionId: string | undefined): Promise<void>;    // optional capability
  claudePlanUsage?(): Promise<ClaudePlanUsage | undefined>;    // Claude-only escape hatch
}
```

- **Why here.** The agent ecosystem moves weekly. The interface was published first (PLAN.md §3.5, work package A) so the server could be built against a stub.
- **Rejected.** Coding the server directly against one SDK.
- **Costs.** Lowest-common-denominator events. Provider-specific features need optional methods (`useSession?`, `claudePlanUsage?`) or options only some adapters honour (`BridgeOptions.additionalDirectories`: "Claude SDK only; ACP has cwd only").
- **Not when.** You have exactly one provider and no realistic second one. An interface with one implementation is overhead; extract it when the second arrives (tests with a fake count as a second).
- **Try it.** Write a fourth adapter, `EchoBridge`, that answers every prompt with the prompt text as one `text` stream event and `end_turn`. Register it the way `MockBridge` is in `AgentCatalog.create`. Nothing in `src/serve/` should change.

#### 6. Catalog + Factory + Strategy for agent selection

- **Problem.** Which agents exist, which are installed, how to launch each, and how to build the right adapter at runtime (`agent.set` from the viewer, project switches).
- **Pattern.** A *registry/catalog* (data describing each option), a *factory* (one place that builds the object), and *strategy* (the chosen adapter is swapped behind the same interface).
- **Where in Ruah.** `AGENTS` and `AgentDefinition` in `src/acp/presets.ts` (id, name, `installHint`, `preset(env)` returning an `AcpPreset` or `undefined` when not installed). `AgentCatalog` in `src/acp/index.ts`: `choices()` (what the viewer lists), `check()` (installed?), `create(agentId, root)` (the factory). `SessionHub` sees it only as the `AgentSwitcher` interface.

```ts
// src/acp/presets.ts — adding an ACP agent is one entry
{
  id: "kiro",
  name: "Kiro CLI",
  description: "Kiro's CLI over ACP (`kiro-cli acp`)",
  listed: true,
  installHint: "Install Kiro CLI: https://kiro.dev/docs/cli/ — then run `kiro-cli login`. …",
  // Never -a/--trust-all-tools: tool approval goes through the viewer.
  preset: cliAgent("kiro-cli", "ARCHMAP_KIRO_BIN", ["acp"]),
},
```

- **Why here.** The viewer renders whatever `agent.status.agents` lists, including disabled entries with install hints. `resolveAgentBinary` also looks in `~/.local/bin` and each tool's own install dir, because a daemon launched from Finder gets a minimal `PATH`.
- **Rejected.** `switch (agentId)` spread over the server and the UI.
- **Costs.** One indirection. The catalog re-probes the filesystem on every `check()`.
- **Not when.** Two options that will never grow; an `if` is clearer.
- **Try it.** Add a `codex` entry using `cliAgent("codex-acp", "ARCHMAP_CODEX_BIN", [])`. Check that it appears in the viewer's agent picker as "not installed" with your hint.

#### 7. Anti-corruption layer

- **Problem.** ACP `session/update` notifications, Claude SDK messages, AWS/DigitalOcean/`gh` JSON and Jira REST all have their own shapes, naming and quirks. If those shapes leak inward, every provider change ripples through the server and the UI.
- **Pattern.** *Anti-corruption layer* (Evans, DDD): translate a foreign model into your own at the edge, so the core only sees your types.
- **Where in Ruah.** `TurnNormalizer` and the parse helpers in `src/acp/acp-normalize.ts` (ACP updates → `StreamEvent`, tool calls merged by `toolCallId`, output capped at `OUTPUT_MAX_CHARS`, replays dropped via `sessionUpdateIsReplay`). The SDK-message mapping inside `ClaudeSdkBridge` (tool_use → `tool_call`, TodoWrite → `plan`, Edit/Write → `diff`). Integrations: pure mappers such as `mapEc2`, `mapLambda` (`src/integrations/cloud/aws.ts`), `mapDroplets` (`cloud/digitalocean.ts`), `mapGhIssue` (`work/github.ts`), reading untyped JSON defensively with `obj`/`arr`/`str` from `src/integrations/exec.ts`.
- **Why here.** Two very different agent runtimes produce the same `StreamEvent` stream, so the viewer renders them identically. Mappers copy only the fields we need, so secrets in provider output (database passwords, function keys) never get past the adapter.
- **Rejected.** Passing provider JSON through to the viewer "for flexibility".
- **Costs.** Mapping code to maintain; features the model does not express are dropped (CONTRACTS §2.5 lists what is ignored).
- **Not when.** The foreign model *is* your domain (you are writing an AWS console). Then adopt it.
- **Try it.** Save the output of `aws lambda list-functions` to a file and feed it to `mapLambda` in a test (fixtures live under `test/fixtures/integrations/`). Then add a field the provider sends that you do not map, and confirm nothing changes.

#### 8. Standard protocol over bespoke integration

- **Problem.** Each agent vendor has its own CLI flags and output. Writing one integration per vendor does not scale.
- **Pattern.** Integrate through a *standard protocol* when one exists: here the Agent Client Protocol (ACP), JSON-RPC 2.0 as newline-delimited JSON over the agent's stdin/stdout.
- **Where in Ruah.** `AcpProcessBridge` (`src/acp/acp-bridge.ts`) with `AgentProcess` (`src/acp/acp-process.ts`) spawns any preset and speaks ACP through `@agentclientprotocol/sdk` (`client()`, `ActiveSession`). One bridge serves Cursor, Grok, Kiro, OpenCode and Claude-over-ACP.
- **Why here.** A new ACP agent is a preset (#6), not a new bridge. stdio needs no ports, no auth and dies with the parent.
- **Rejected.** Per-vendor CLI wrappers; screen-scraping terminal output.
- **The exception, and why.** Claude runs on the Claude Agent SDK (`ClaudeSdkBridge`), not over ACP, because the SDK loads the user's own Claude Code setup (`settingSources` user/project/local: skills, plugins, MCP servers, CLAUDE.md) and exposes plan usage. The Claude ACP adapter remains available as `claude-acp`. A standard is the default, not a religion.
- **Costs.** You inherit the protocol's gaps (ACP 1.4 has no additional working directories; resume depends on the agent advertising `loadSession`) and its churn (PLAN.md §6 pins exact versions for that reason). Some agents need non-standard handling anyway (OpenCode exposes modes only as a config option; see `parseModeConfigOption`).
- **Not when.** No standard exists, or the standard is so young that every implementation deviates. Then keep your own port (#5) and write adapters.
- **Try it.** Read `test/fake-agent.ts`: it is a complete ACP agent in about 340 lines. Add a scenario that sends a `plan` update and check the viewer renders a checklist.

#### 9. Test doubles at process boundaries

- **Problem.** Real agent turns are slow, cost money and are nondeterministic. UI work and protocol tests cannot wait on them.
- **Pattern.** *Test doubles* (Meszaros): fakes and stubs placed at the process or I/O boundary, behind the same interface as production.
- **Where in Ruah.** `MockBridge` (`src/acp/mock-bridge.ts`, `archmap serve --mock`): a scripted turn with text, a read, an edit, a permission request, a diff. `test/fake-agent.ts`: a real ACP agent *process* whose script is chosen by the prompt text (`text`, `tool`, `permission`, `hang`, `slow`, `crash`, …). Injection points: `ClaudeSdkBridgeDeps.queryImpl`, the `Runner` type in `src/integrations/exec.ts` (every CLI call can be faked), `MemorySecretStore` in `src/integrations/keychain.ts`, `Launcher` in `src/integrations/ruah.ts`.
- **Why here.** The fake agent tests the real bridge over a real pipe, including crashes and a cancel that is never answered (`hang`), which you cannot reliably provoke with a real model. The mock let the whole viewer be built before the agent bridge worked.
- **Rejected.** Mocking the SDK's internals function by function (brittle and tests nothing real).
- **Costs.** Fakes drift from real agents; the fake agent logs protocol-visible effects to stderr (`fake: …`) so tests can assert ordering, which is extra machinery. Fakes do not replace live smoke tests (#47).
- **Not when.** The boundary is cheap and deterministic (a pure function); call the real thing.
- **Try it.** Run `pnpm vitest test/bridge.test.ts`. Then add a fake-agent scenario that emits a tool call with an absolute path outside the repo and assert what `ToolCallView.locations` contains.

#### 10. Plugin registry for integrations

- **Problem.** Cloud (DigitalOcean, AWS), work items (Jira, GitHub) and orchestration (ruah) all need connect/disconnect/status plus family-specific reads. We did not want provider names in the HTTP layer or the UI.
- **Pattern.** *Plugin registry*: providers implement a small interface and register themselves; the rest of the system iterates the registry.
- **Where in Ruah.** `Integration`, `CloudIntegration`, `WorkIntegration` and `IntegrationRegistry` in `src/integrations/registry.ts`. `IntegrationsService` (`src/integrations/index.ts`) and `handleIntegrationsRequest` (`src/integrations/http.ts`, one hook in `startServer`) never name a provider. The viewer renders whatever `GET /api/integrations` returns.
- **Why here.** Adding GCP or Linear is one adapter class and one `register()` call.
- **Rejected.** One module per endpoint family with `switch (provider)` inside each.
- **Costs.** Lowest-common-denominator interface; provider extras ride in optional fields (`accounts`, `detail`, `setupHint`). Type guards (`isCloud`, `isWork`) replace a richer type system.
- **Not when.** The "plugins" share almost nothing. Then separate modules are simpler than a forced common interface.
- **Try it.** Sketch a `LinearIntegration implements WorkIntegration` with `search`/`get`/`create` stubbed through a fake `Runner`. Count the files you had to touch outside `src/integrations/work/`.

#### 11. Delegate to the provider's own CLI

- **Problem.** Talking to AWS or DigitalOcean directly means SDKs, credential chains, SSO refresh, pagination and retries.
- **Pattern.** *Adapter over a CLI*: use the tool the user already installed and logged into as the integration surface; each adapter is an invocation table plus pure mappers (#7).
- **Where in Ruah.** `REGIONAL` listing table in `src/integrations/cloud/aws.ts` (`{ service: "ec2", args: ["ec2", "describe-instances"], map: mapEc2 }` …), the `doctl` equivalent in `cloud/digitalocean.ts`, `gh` in `work/github.ts`, `ruah` in `src/integrations/ruah.ts`. Missing CLI → status `cli_missing` with a `setupHint`.
- **Why here.** The CLIs already solve auth, SSO refresh and pagination, and the user already trusts them. Ruah stores no cloud credentials at all (#31).
- **Rejected.** AWS/DO SDKs (heavy dependencies, their own credential handling).
- **Costs.** The CLI must be installed. Output formats drift (mappers ignore unknown fields). Process spawn per call (bounded by `mapLimit` and `CLI_TIMEOUT_MS`).
- **Not when.** High-frequency calls, or a server environment where you control credentials anyway; use the SDK.
- **Try it.** Add one AWS listing (for example `ecr describe-repositories`) as a new row plus a mapper and a fixture test. No other file should need to change.

#### 12. A seam for work in flight elsewhere

- **Problem.** Projects/launcher and multi-repo systems were built in parallel. The project service had to open a `ruah.system.json` folder before the multi-repo code existed.
- **Pattern.** A *seam* (Feathers): an injected dependency with a safe default, so two pieces of work can land independently and be wired later. Plain *dependency injection*.
- **Where in Ruah.** `ProjectServiceDeps.openSystemProject` with the default `openSystemProjectNotWired` (answers 501) in `src/projects/service.ts`. `ServeHooks` in `src/serve/run-serve.ts` is where the lead wired `makeOpenSystemProject` (`src/system/open.ts`) in commit `a78bf51`. Same idea: `suggestConnections(system, runAgent)` in `src/system/suggest.ts` takes the agent call as a function.
- **Why here.** Neither package imported the other, so neither blocked the other and merges did not conflict.
- **Costs.** One indirection; stale docs are easy (CONTRACTS §5.5 still mentions the 501 after it was wired).
- **Not when.** Everything is built by one person in sequence.
- **Try it.** Find a feature in your system that is "waiting on another team". Define the function signature it needs, inject it with a default that returns a clear "not available yet" error, and ship.

---

### C. Communication and concurrency

#### 13. Push over WebSocket, request/response over HTTP

- **Problem.** Agent turns stream tokens, tool calls and permission requests for seconds or minutes. Files, context packs and usage summaries are one-shot reads.
- **Pattern.** Use the right channel per interaction: a persistent *event stream* (WebSocket) for server-initiated updates, plain *request/response* (HTTP) for reads and commands with a single answer.
- **Where in Ruah.** `/ws` in `startServer` (`src/serve/server.ts`), handled by `attachSession` / `handleClientMessage` (`src/serve/session.ts`). HTTP: `/api/file` (`src/serve/files.ts`), `/api/context/:nodeId` (`context-endpoint.ts`), `/api/rescan`, `/api/projects/*` (`projects-http.ts`), `/api/usage/*` (`src/usage/http.ts`), `/api/integrations` etc.
- **Why here.** Streaming needs push. Reads are simpler, cacheable and curl-able over HTTP. One origin serves both, so the viewer only needs one address.
- **Rejected.** Everything over WebSocket (reinvents request ids and errors for simple reads); polling for turn progress (latency, waste).
- **Costs.** Two error models (WS `error{code}` frames vs HTTP status codes) and two places to apply the Origin check (#34).
- **Not when.** Nothing is server-initiated; plain HTTP is enough. Or you need server push only: Server-Sent Events are simpler than WebSockets.
- **Try it.** Watch one turn in the browser devtools: the WS frames (`turn.started`, `stream` ×N, `turn.finished`) next to the single `GET /api/file` when you open the Code tab.

#### 14. Observer / publish–subscribe with unsubscribe handles

- **Problem.** Several parts must react to the same change: a bridge event goes to the hub, the pool and the usage log; a file change goes to every open viewer.
- **Pattern.** *Observer* (GoF) inside the process, *pub/sub* fan-out to clients. Every subscription returns its own unsubscribe function.
- **Where in Ruah.** `AcpBridge.on(listener)` returns `() => void`. `ArchitectureStore.onChange` / `onError` (`src/serve/architecture-store.ts`). `BridgePool` subscribes in `track()` and unsubscribes in `evict()`. `SessionHub.broadcast` fans out to every socket. `setProject` calls each stored unsubscribe of the old project before attaching the new one.
- **Why here.** Unsubscribe-by-handle makes teardown explicit, which matters because projects and agents are swapped at runtime (#43). Stale listeners are also guarded: `if (this.open?.store !== store) return;`.
- **Costs.** Event ordering and "who is listening right now" become implicit. An event emitted before anyone subscribed is lost (that caused a real bug; see #15 and section 3).
- **Not when.** One producer, one consumer, synchronous: call the function.
- **Try it.** Find every `on(`/`onChange(` in `src/serve/session.ts` and check each has a matching unsubscribe. Do the same audit in your own code base; leaked listeners are a classic memory leak.

#### 15. Handshake, then snapshot (state replay on connect)

- **Problem.** A viewer that connects late (a second tab, a reconnect) does not know the current architecture, agent, model or modes until something changes.
- **Pattern.** On connect, send the *last-known state* before any deltas. The server keeps a merged snapshot, not just an event stream. Related: event-carried state transfer; the "initial snapshot + updates" shape of most sync protocols.
- **Where in Ruah.** `hello` must be the first frame (rule 1, enforced in `attachSession`). `SessionHub.sendHello` then sends `project`, `architecture`, `agent.status`, `chats`, `chat.history`. The agent part comes from `agentStatusMessage()`, which reads the pool entry's merged status. `mergeStatus` in `src/serve/bridge-pool.ts` folds each partial status event into that snapshot (fields are only sent when they change).

```ts
// src/serve/session.ts
sendHello(socket: WebSocket): void {
  this.send(socket, { type: "project", project: this.project() });
  const arch = this.architectureMessage("initial");
  if (arch !== undefined) this.send(socket, arch);
  this.send(socket, this.agentStatusMessage());
  const chats = this.chatsMessage();
  if (chats !== undefined) this.send(socket, chats);
  const history = this.historyMessage();
  if (history !== undefined) this.send(socket, history);
}
```

- **Why here.** A late joiner is correct immediately. The bug that led here: `hello` used to answer only `{ state }`, so a new tab showed no model or modes until the agent happened to emit a status change (`ed9ddbf`).
- **Rejected.** Having the client re-request each piece (more round trips, more ordering bugs). Full event replay from the start (unbounded).
- **Costs.** The server must maintain the snapshot and keep it consistent with the events it sends. Mid-turn state is not replayed yet (CONTRACTS §2.2 rule 6: a viewer disconnect cancels the turn).
- **Not when.** Clients are short-lived and always start with a full HTTP fetch anyway.
- **Try it.** Open the viewer in two tabs, change the model in one, then open a third. The third must show the new model at once. Now find the code path that makes that true.

#### 16. Single writer: one active turn

- **Problem.** An agent session is one conversation working in one repo. Two concurrent prompts would interleave tool calls and edits in the same files.
- **Pattern.** *Single-writer principle*: exactly one actor mutates a piece of state at a time; others are rejected rather than queued.
- **Where in Ruah.** `BusyError` in `src/acp/bridge.ts` (thrown by `prompt()` while a turn is active). `SessionHub.activeTurn` and the state check in `startTurn` (`src/serve/session.ts`) answer `error{busy}`. The viewer disables the composer and turns Send into Stop while a turn runs.
- **Why here.** Simple, and it matches how agents work: one session, one turn. Recovery is simple too: state `error` still accepts a prompt, because both real bridges restart the agent on the next prompt.
- **Rejected.** A prompt queue (users lose track of what runs when); multiple sessions per project (conflicting edits).
- **Costs.** No parallel work within one project and one agent. Any socket closing during a turn cancels it (`attachSession` close handler), even when another tab is still connected.
- **Not when.** The work items are independent (different files, different sessions). Then use a pool of writers with ownership rules, which is exactly what the build process did with worktrees (#45).
- **Try it.** Send two `prompt` frames back to back with different `turnId`s and read the second answer. Then decide whether "reject" or "queue" is right for the busiest resource in your system, and write down why.

#### 17. Cancellation with a deadline and supervisor-style restart

- **Problem.** A user presses Stop. The agent may be blocked on a permission request, may ignore the cancel, or may hang.
- **Pattern.** *Cooperative cancellation with a deadline*, then *let it crash and restart* (supervisor, as in Erlang/OTP): ask politely, wait a bounded time, then kill and respawn.
- **Where in Ruah.** `AcpProcessBridge.cancel` (`src/acp/acp-bridge.ts`), ported from t3code: (a) answer every pending permission of the turn with `cancelled` (the agent may be waiting on one), (b) yield a macrotask so those answers reach the pipe first, then send `session/cancel`, (c) race the prompt against `DEFAULT_CANCEL_TIMEOUT_MS` (15 s); on timeout `retireAfterCancelTimeout` kills the process and starts a new one. Crashes (`onExit`) respawn once (`crashRespawns < 1`). `ClaudeSdkBridge.cancel` calls `query.interrupt()` with the same 15 s timer; on timeout it closes the query and the next prompt resumes the session (a lazy restart).

```ts
// src/acp/acp-bridge.ts (cancel, step c)
const outcome = await Promise.race([
  turn.done.then(() => "done" as const),
  new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), this.cancelTimeoutMs); }),
]);
clearTimeout(timer);
if (outcome === "timeout" && !turn.finished && this.runtime === rt) {
  await this.retireAfterCancelTimeout(rt, turn);
}
```

- **Why here.** A stuck agent must never wedge the daemon. The order in (a)→(b) matters: the fake agent's `hang` and `permission` scenarios assert that permissions are cancelled before `session/cancel`.
- **Rejected.** Killing immediately (loses the agent's clean shutdown and session state); waiting forever.
- **Costs.** A killed agent loses in-flight work; the turn ends as `error`, not `cancelled`. Respawn-once means a crash loop ends in state `error` rather than spinning.
- **Not when.** The operation is not safe to abandon halfway (a payment). Then you need idempotency or compensation, not a kill.
- **Try it.** In `test/bridge.test.ts`, find the `hang` scenario and shorten `cancelTimeoutMs`. Then add a check that after the restart a new prompt succeeds.

#### 18. Reconnect with exponential backoff, and a degraded mode

- **Problem.** The daemon restarts during development, the laptop sleeps, the viewer may be opened with no daemon at all (Lovable preview).
- **Pattern.** *Retry with exponential backoff* plus *graceful degradation*.
- **Where in Ruah.** `scheduleReconnect` in `ui/src/lib/daemon.ts`: `BACKOFF_MIN_MS` 500 → `BACKOFF_MAX_MS` 8000, reset on open. If the first attempt does not open within `FIRST_ATTEMPT_TIMEOUT_MS` (2.5 s), `fallBackToSample()` renders the bundled sample architecture read-only. Unsaved edits are marked for resend (`needsResend`) and sent again after reconnect.

```ts
// ui/src/lib/daemon.ts
function scheduleReconnect() {
  if (reconnectTimer !== undefined) return;
  const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, attempt - 1));
  reconnectTimer = setTimeout(() => { reconnectTimer = undefined; connect(); }, delay);
}
```

- **Why here.** One client per daemon, so no thundering herd; jitter was not needed. The sample fallback makes the viewer demoable without a backend.
- **Costs.** Without jitter, many clients would reconnect in lockstep. The sample can be mistaken for real data (the store marks `source: "sample"`).
- **Not when.** Retrying is unsafe (non-idempotent requests) or pointless (auth failures). Retry only what can succeed later.
- **Try it.** Add ±20 % jitter to `scheduleReconnect` and explain in one sentence when it would matter.

#### 19. Serialize conflicting operations (a single-flight queue)

- **Problem.** Two quick clicks on two projects would run two `open`s concurrently, each swapping the hub's store.
- **Pattern.** Serialize operations that mutate the same thing through a promise chain (an in-process mutex / *serial executor*).
- **Where in Ruah.** `ProjectService.serialize` (`src/projects/service.ts`). The same shape serializes appends in `UsageLog.append` (`src/usage/log.ts`). `SessionHub.switchAgent` uses a simpler flag (`switching`) and rejects a second switch with `busy`.

```ts
// src/projects/service.ts
private serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = this.queue.then(task, task);   // ← runs even if the previous task failed
  this.queue = run.catch(() => {});          // ← a failure must not poison the queue
  return run;
}
```

- **Why here.** Five lines, no library, and it removes a whole class of interleaving bugs.
- **Costs.** Head-of-line blocking: a slow open (a large system scan) delays the next one. Only works within one process.
- **Not when.** Operations are independent; serializing them only adds latency. Across processes, you need a lock file or a database.
- **Try it.** Write a test that fires `open(A)` and `open(B)` without awaiting and asserts that B is the project that ends up open. Remove `serialize` and watch it fail intermittently.

---

### D. Data and state

#### 20. The file is the source of truth (architecture as code), with file watching

- **Problem.** Where should the architecture map live so that humans, the UI, the scanner and agents can all read and change it, and so changes are reviewable?
- **Pattern.** *Configuration/architecture as code*: a plain file in the repo is the source of truth; everything else is a cache or a view. The server *watches* it and pushes changes.
- **Where in Ruah.** `<repo>/architecture.json`. `createArchitectureStore` (`src/serve/architecture-store.ts`) loads, validates, lays out, watches and broadcasts (`onChange` → `architecture{reason:"changed"}`). The watcher is on the **directory**, filtered by file name, debounced 250 ms, so editors that save by rename (new inode) are still seen.
- **Why here.** Diffable in pull requests, editable by any tool, no database to migrate or back up. An agent that edits the file updates every open viewer within a quarter of a second.
- **Rejected.** A database or a hidden cache in `~/.ruah` (not reviewable, not shared through git).
- **Costs.** Concurrent writers can race (last writer wins). `fs.watch` is platform-dependent; failures are non-fatal and the file is still served on demand.
- **Not when.** High write rates, many concurrent writers, or data that must not be in the repo (secrets, per-user state; see #30).
- **Try it.** With the daemon running, edit a node's `description` in `architecture.json` by hand and watch the viewer update. Then break the JSON and see `architecture.error` while the old map stays up (#21).

#### 21. Validate on load, keep the last good version; replace atomically

- **Problem.** A half-typed hand edit or a buggy writer must not blank the map, and a crash mid-write must not leave a torn file.
- **Pattern.** *Keep last known good*: reject an invalid new version and keep serving the previous one. *Atomic replace*: write a temp file, then `rename` over the target.
- **Where in Ruah.** `reload()` in `src/serve/architecture-store.ts` calls `readValidated`; on error it emits `architecture.error` and returns without touching `current`. `save()` validates first, then `atomicWrite`. The same temp-then-rename is `atomicWriteFileSync` in `src/projects/fs-util.ts` (projects, chats) and `atomicWrite` in `src/integrations/store.ts`. A rejected save reaches the viewer as `error{save_rejected}`, which it uses to revert (#27).

```ts
// src/serve/architecture-store.ts
function reload(reason: StoreChangeReason): void {
  const res = readValidated(archPathAbs, root);
  if ("error" in res) {
    // Invalid file: keep the last good revision, emit architecture.error.
    emitError(res.error);
    return;
  }
  apply(res.architecture, initial ? "initial" : reason);
  initial = false;
}
```

- **Why here.** Humans edit this file by hand. Readers only ever see the old file or the new one.
- **Costs.** The UI can show a map that no longer matches the file on disk; the error banner must make that visible.
- **Not when.** Data where "stale but valid" is worse than "unavailable" (prices, permissions).
- **Try it.** Find every `writeFileSync` in your own code base that writes a file other programs read. Replace the ones that are not atomic.

#### 22. Deterministic generation + merge of hand edits

- **Problem.** `archmap scan` generates the map from the code. People then add descriptions, notes, layout and concepts the scanner cannot see. Re-scanning must not destroy that work, and re-scanning an unchanged repo must not produce a diff.
- **Pattern.** *Deterministic generation* (same input → byte-identical output) plus a *three-way-ish merge* with explicit ownership rules per field: generated fields are refreshed, human fields win.
- **Where in Ruah.** `scanRepo` in `src/scan/index.ts` ("Output is deterministic: sorted inputs, stable ids, no timestamps unless `opts.now` is given"); `listFiles` (`src/scan/walk.ts`) returns sorted paths. `mergeWithExisting` in `src/scan/merge.ts`: a node in both keeps `description`, `notes`, `x`, `y`; hand-added nodes (no `path`) survive; scanned nodes whose path vanished are dropped. `POST /api/rescan` runs scan + merge and saves through the store.
- **Why here.** Diffs stay meaningful ("the scan found a new package"), so a re-scan is safe to run any time.
- **Rejected.** Regenerating from scratch (loses human knowledge); storing hand edits in an overlay file (two files to keep consistent).
- **Costs.** The merge rules are code that must be understood by users. **Known gap:** the single-repo merge keeps only edges that touch a hand-added node, so a hand-drawn edge between two *scanned* nodes is dropped on re-scan even though the editor marks it `source: "manual"`. The system merge (#23) handles this correctly; the repo merge does not yet.
- **Not when.** Nobody edits the output; then just regenerate.
- **Try it.** Fix the known gap: make `mergeWithExisting` keep existing edges whose `source` is `manual` or `suggested` when both ends still exist, mirroring `mergeSystemWithExisting`. Write the test first.

#### 23. Provenance on derived data

- **Problem.** In a system map, edges come from three places: the scanner, an accepted AI suggestion, and a human. A re-scan must replace only what it produced.
- **Pattern.** *Data provenance* (lineage): every derived record says where it came from, so each producer owns and replaces only its own records.
- **Where in Ruah.** `ArchEdge.source: "scan" | "suggested" | "manual"` (CONTRACTS §1.5, `src/contracts/architecture.ts`). `mergeSystemWithExisting` in `src/system/merge.ts`: scan edges replace old scan edges wholesale; every other edge is kept while both ends exist; a missing `source` is treated as `manual`; on conflict the human edge wins. The viewer marks drawn edges `manual` and converts an edited scan edge to `manual` (`ui/src/lib/architecture-edit.ts`). Cloud links carry `linkSource: "tag" | "name" | "manual"`.
- **Why here.** Regeneration and human knowledge coexist without a diff/patch step, and the UI can style or filter by origin.
- **Rejected.** Tombstones for deleted scan edges (not needed yet); a separate overlay file.
- **Costs.** Every client that edits must round-trip `source` (CONTRACTS §1.5 says so explicitly). A client that strips unknown fields silently turns scan edges into manual ones.
- **Not when.** There is one producer.
- **Try it.** Add a `source` field to one derived table in your own system (for example "imported" vs "user-entered") and write the re-import so it replaces only its own rows.

#### 24. Evidence-backed inference

- **Problem.** Cross-repo edges are inferred with heuristics. People will not trust a map they cannot check.
- **Pattern.** *Explainable inference*: every inferred fact carries the evidence that produced it, in a form the user can open.
- **Where in Ruah.** `detectCrossRepoSignals` in `src/system/signals.ts`: rules only fire when they can point at a line (compose/k8s/terraform names, `*_URL`/`*_HOST` values, topic publish/consume pairs, internal package dependencies). Each edge gets `evidence: ["<repoId>/<path>:<line>", …]`, sorted, at most `MAX_EVIDENCE` (10).
- **Why here.** A user can judge a false positive in one click instead of the tool hiding uncertainty.
- **Rejected.** Per-language AST analysis (slow, still blind to config); runtime tracing (needs the system running).
- **Costs.** Regex heuristics miss dynamic names (`topic: cfg.topic`) and localhost URLs; byte and file caps (`MAX_SIGNAL_FILES`, `MAX_REPO_BYTES`) can miss signals in huge repos.
- **Not when.** The inference is cheap to verify by other means, or evidence would leak data the viewer should not see.
- **Try it.** Run `archmap system scan` on two repos where one calls the other through an env var, then open the edge's evidence. Change the variable name so the rule no longer matches and see the edge disappear.

#### 25. Federation + namespacing (multi-repo systems)

- **Problem.** Microservices live in separate repos. We want one system map, while each repo keeps owning its own map and hand edits.
- **Pattern.** *Federation*: compose a global view from independently owned parts instead of re-modelling them. *Namespacing* to keep identifiers unique. *Entity resolution* by canonical key for shared things.
- **Where in Ruah.** `ruah.system.json` lists repos by relative path (`loadSystem`, `SystemFileSchema` in `src/system/config.ts`). `buildSystemArchitecture` (`src/system/build.ts`) reuses each repo's valid `architecture.json` or scans it in memory, then prefixes ids `<repoId>:<nodeId>` and paths `<repoId>/<path>`. `resolveSystemPath` maps a system path back to the right repo on disk (and refuses `..`). Shared infra is deduplicated by kind (`sharedKindFromInfraKey`: a compose `postgres:16` and a `pg` dependency become one `postgres` node). The id pattern in `validate.ts` (`ID_PATTERN`) accepts one optional `<repoId>:` prefix.
- **Why here.** Each repo stays authoritative, the system file is small and committable, adding a repo is one line. Prefixes are stable across scans and reversible.
- **Rejected.** One giant scan of a parent folder (repos are not siblings in general); renumbering duplicates (`api-2` changes meaning when order changes); a central database.
- **Costs.** Edits made in the system view do not flow back into the repo's own file. Deduplication by kind collapses two genuinely separate Postgres clusters into one node. Every id validator had to learn the prefix (the viewer's did not at first; section 3).
- **Not when.** Parts are not independently owned; a single model is simpler.
- **Try it.** Create `ruah.system.json` for two repos that both have a node `api`. Run `archmap system scan` and look at the ids. Then call `resolveSystemPath` with `"other/../../etc/passwd"` and confirm it returns `null`.

#### 26. Projections: one model, many views

- **Problem.** The same architecture must appear as a drill-down diagram, a file tree, workflow diagrams, a cloud overlay and a text context for agents.
- **Pattern.** *Projection* (derived view, read model): pure functions from the canonical model to each view; the views are never stored.
- **Where in Ruah.** Viewer: `toGraph(arch, parentId)` (one drill level), `workflowGraph`, `toRepoTree`, `diagramsFromArchitecture` in `ui/src/lib/architecture.ts`; `cloudGraph` in `ui/src/lib/integrations.ts`. Daemon: `ArchIndex` (`src/context/graph.ts`) and `buildContextPack` (`src/context/pack.ts`) project the same model into prompt text. Cloud links are recomputed on every read (`linkResources` in `src/integrations/linking.ts`).
- **Why here.** One place to change data, no sync bugs between views. `ui/src/lib/workspace.tsx` states it outright: diagrams are derived; `localStorage` keeps only UI layout.
- **Costs.** Recomputed on each change (fine at hundreds of nodes; memoize when it is not).
- **Not when.** A view is expensive to compute and read far more than the source changes; then materialize it (and give it provenance, #23).
- **Try it.** Write `toMermaid(arch, parentId)` next to `toGraph` that emits a Mermaid flowchart of one level. It should need nothing but the `Architecture` value.

#### 27. Optimistic UI with debounce and revert

- **Problem.** Editing the map must feel instant, but the daemon is the one that validates and writes.
- **Pattern.** *Optimistic update*: apply the change locally at once, send it in the background, reconcile on the answer. *Debounce* bursts of edits into one save.
- **Where in Ruah.** `editArchitecture` in `ui/src/lib/daemon.ts` keeps a local `draft`, shows it immediately, and schedules `flushSave` after `SAVE_DEBOUNCE_MS` (500 ms), which sends `architecture.save`. On `error{save_rejected}` the draft is dropped and the UI reverts to the server's architecture. On disconnect the draft is kept and resent (`needsResend`). The daemon's `architecture{reason:"saved"}` broadcast updates other tabs.

```ts
// ui/src/lib/daemon.ts
export function editArchitecture(fn: (arch: Architecture) => Architecture | null) {
  if (!canEdit()) return;
  const base = draft ?? state.architecture;
  if (!base) return;
  const next = fn(base);
  if (!next || next === base) return;
  draft = next;
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  set({ architecture: next, save: "pending" });
}
```

- **Why here.** Dragging a node produces dozens of edits per second; one save per pause is enough.
- **Rejected.** Pessimistic saves (spinner per edit).
- **Costs.** Whole-document saves: two tabs editing at once are last-writer-wins. A typed error code was needed to know when to revert (it used to arrive as `internal`; section 3).
- **Not when.** The server often rejects, or the cost of showing a wrong state is high (money, permissions).
- **Try it.** The editor already refuses obvious mistakes such as self-edges, so force a daemon-side rejection: in a local branch, make `validateArchitecture` reject any node named `reject-me`, rename a node to that in the UI, and watch the revert. Then find the `save_rejected` branch in `daemon.ts` that makes it happen.

#### 28. Append-only event log, aggregated on read (usage)

- **Problem.** Record token usage per turn across every daemon on the machine (one per repo, possibly several at once) and show summaries by range and model.
- **Pattern.** *Append-only log* of facts plus *aggregate on read* (a small, hand-rolled cousin of event sourcing with projections).
- **Where in Ruah.** `UsageLog` (`src/usage/log.ts`) appends one JSON line per finished turn to `~/.ruah/usage.jsonl` (`$RUAH_HOME` overrides), serialized in-process and starting on a fresh line if a crash left a partial one. `parseUsageLine` skips lines that do not parse. `summarizeUsage` / `UsageAggregator` (`src/usage/summary.ts`) stream and fold the file per request. One recording point: `SessionHub.recordUsage` on `turn_finished`, not per bridge. Per-turn numbers are *differences* of the SDK's cumulative per-query counters, so nothing is double-counted.
- **Why here.** Many writers without coordination (small appends), human-readable, greppable, crash-tolerant. Aggregation rules (buckets, null costs) can change without migrating stored data.
- **Rejected.** SQLite (native dependency and cross-process locking for a few thousand rows a month); pre-aggregated counters (lose per-turn detail, need migrations when buckets change); parsing Claude's private transcripts (Claude-only).
- **Costs.** O(n) read per request (fine at about 1 KB a day; rotate or compact if it reaches many MB). Multi-model turns are attributed to the primary model. Limits (`UsageLimitsService`) are in memory only.
- **Not when.** Reads are frequent and the log is large; then maintain a materialized aggregate alongside the log.
- **Try it.** `tail -n 3 ~/.ruah/usage.jsonl`, then append a garbage line and confirm `GET /api/usage/summary?range=24h` still works.

#### 29. One file per aggregate, records compacted on write (chats)

- **Problem.** Store chat history per project so a chat can be reopened and redrawn, without storing every streamed token.
- **Pattern.** One file per aggregate (*document per entity*), a header line plus records, rewritten atomically; *compaction* of the event stream before storing.
- **Where in Ruah.** `ChatStore` (`src/projects/chat-store.ts`): `~/.ruah/projects/<projectId>/chats/<chatId>.jsonl`, line 1 = `ChatInfo` (plus internal `sessions` per agent), then one `TurnRecord` per finished turn. `appendStreamEvent` compacts while recording: adjacent text chunks are merged, tool calls are upserted by id, the plan is replaced.
- **Why here.** Delete a chat = delete a file; listing reads only first lines (`readFirstLine`); the stored events are exactly what the viewer would redraw, 10–100× smaller than raw token events.
- **Rejected.** SQLite (as for usage); append-only with header-update lines (readers must fold; renames grow the file).
- **Costs.** Each finished turn rewrites the chat file (fine at KB–MB). Two daemons writing the same chat would be last-writer-wins.
- **Not when.** Records are large or frequent enough that rewriting becomes expensive; then append and compact in the background.
- **Try it.** Open a chat file after a turn with many tool calls. Count the `tool_call` entries and compare with the number of updates the agent streamed.

#### 30. Split stores by sharing semantics (links as code)

- **Problem.** Links between elements and work items should be shared with the team. Links to cloud resources are machine-specific (accounts differ per developer). Provider selections are personal.
- **Pattern.** Put each kind of state where its *sharing and lifetime* belong: repo (shared through git), per-user per-project, per-user global. Format shared files for minimal diffs.
- **Where in Ruah.** `src/integrations/store.ts`: `<repo>/.ruah/links.json` (`formatLinks`: sorted, de-duplicated, stable 2-space JSON, written only on change); `~/.ruah/projects/<id>/cloud.json` (`CloudCacheStore`: last sync + manual links); `~/.ruah/integrations.json` (`SettingsStore`: selections, mode 0600, no secrets).
- **Why here.** A teammate pulls the repo and sees the same issue links; nobody's AWS account ids end up in git.
- **Rejected.** Storing links inside `architecture.json` (couples the diagram to one tracker; noisy diffs).
- **Costs.** Two link stores with different semantics to explain.
- **Not when.** All state has the same audience.
- **Try it.** Link an issue to an element twice and check `links.json` still has one entry and a one-line diff.

---

### E. Security

#### 31. Credential delegation: never in files, argv or logs

- **Problem.** Integrations need credentials. Every stored secret is something to leak, back up, or commit by accident.
- **Pattern.** *Credential delegation*: let the tool that already holds the credential do the authenticated work; store only what you must, in the OS secret store; keep secrets out of files, process arguments and logs.
- **Where in Ruah.** Cloud uses the CLI's own login (doctl contexts, AWS profiles/SSO, `gh auth`); Ruah stores only the selection. The one token Ruah must keep (Jira) goes to the macOS Keychain via `/usr/bin/security` in `Keychain.set` (`src/integrations/keychain.ts`), after it is verified with `/rest/api/3/myself`. The write runs `security -i` and sends the command on **stdin**, because argv is visible to other processes of the same user. Errors are built without arguments and passed through `redact()` (`src/integrations/exec.ts`).

```ts
// src/integrations/keychain.ts (Keychain.set)
if (/["\\\r\n]/.test(secret) || /["\\\r\n]/.test(account)) throw new KeychainError("the token or account contains unsupported characters");
const command = `add-generic-password -U -s "${this.service}" -a "${account}" -w "${secret}"\n`;
const { code, stdout, stderr } = await this.exec("write", ["-i"], secret, command);
// In interactive mode the exit code is 0 even when a command fails; errors are printed.
if (code !== 0 || /error|SecKeychain/i.test(`${stdout}\n${stderr}`)) throw new KeychainError(redact(`keychain write failed (security exit ${code})`, [secret]));
```

- **Why here.** No secret files to protect. Users keep one login per provider. "Disconnect" clears Ruah's selection and never logs a CLI out.
- **Rejected.** An encrypted token file (then you manage a key); environment variables (inherited by child processes, dumped in crash logs).
- **Costs.** macOS-only token storage for now. Stdin mode needs input sanitising (quotes and newlines are refused).
- **Not when.** Server-side services; use the platform's secret manager and workload identity instead.
- **Try it.** Run `ps -axo args | grep security` while connecting Jira: nothing with the token should appear. Then grep your own code for secrets passed as command-line arguments.

#### 32. Safe process execution

- **Problem.** The daemon runs `git`, `doctl`, `aws`, `gh`, `ruah` and agent CLIs, some with user-supplied values (folder names, queries, titles).
- **Pattern.** Never build shell strings: `execFile` with an argument array, bounded time and output, validated inputs, and error messages that cannot echo secrets.
- **Where in Ruah.** `defaultRunner` in `src/integrations/exec.ts`: args array, `CLI_TIMEOUT_MS` (20 s), `MAX_BUFFER`, a `PATH` that adds Homebrew dirs (GUI launches get a bare `PATH`), `redact()` on every message. User text is passed as `--flag=value` so it can never be parsed as a flag. `git init` on project create runs as `execFile("git", ["init","-q"], {cwd})` after the folder name is validated (no separators, not `.`/`..`, no control characters). Long-running `ruah task start` / `workflow run` are launched detached with a log file (`detachedLauncher` in `src/integrations/ruah.ts`).
- **Why here.** Command injection is the classic bug of tools that wrap other tools.
- **Costs.** Some CLI features that need a shell (pipes, globs) must be reimplemented in code.
- **Not when.** Never skip it; if you truly need a shell, pass no user input into it.
- **Try it.** Create a project named `a;touch /tmp/pwned` through the start screen and confirm it is rejected. Then look for `exec(` (not `execFile`) in your own code.

#### 33. Read-only by default; confirm every side effect

- **Problem.** Integrations touch real systems: cloud accounts, trackers, task runners. A bug or a misclick should not create or change anything.
- **Pattern.** *Safe by default*: reads need no confirmation, writes are few, named and explicitly confirmed by the user.
- **Where in Ruah.** Sync/search/status only call `list`/`describe`/`get`/`view`. The writes are enumerated in CONTRACTS §6.2: `POST /api/work/create` (the viewer's `CreateIssueDialog` has a separate confirm step), ruah task create/start/done/merge/cancel, workflow run. `WorkIntegration.create` is documented as "The only state-changing call". Ruah never runs `ruah init` or `--skip-gates` for the user. Every write is a POST behind the Origin check (#34).
- **Why here.** It makes the system easy to trust, and easy to audit: grep for the write list.
- **Costs.** An extra click per write.
- **Not when.** Writes are the product and easily undone (a text editor).
- **Try it.** List every endpoint in your service that changes external state. If you cannot produce the list in five minutes, that is the finding.

#### 34. Origin checks on localhost (CSRF defence)

- **Problem.** Any website open in the same browser can send requests to `http://127.0.0.1:4177`. Without a check, a malicious page could trigger a rescan, open a project, connect an integration or drive the agent over the WebSocket.
- **Pattern.** *Origin allow-listing* for state-changing requests and WebSocket upgrades (a standard CSRF defence), plus binding to loopback only.
- **Where in Ruah.** `originAllowed` / `originMatches` in `src/serve/server.ts`: loopback origins or `--allow-origin` globs (for a Lovable preview). Checked on the `/ws` upgrade (403 before the socket opens), `POST /api/rescan`, every `POST /api/projects/*` (`projects-http.ts`) and every integrations POST (`src/integrations/http.ts`), before the body is read.

```ts
// src/serve/server.ts
export function originAllowed(origin: string | undefined, allowOrigins: readonly string[]): boolean {
  if (origin === undefined) return true; // non-browser clients (curl, tests)
  let host = "";
  try { host = new URL(origin).hostname; } catch { return false; }
  if (host === "localhost" || host === "127.0.0.1") return true;
  return allowOrigins.some((glob) => originMatches(origin, glob));
}
```

- **Why here.** Browsers always send `Origin` on cross-site requests and WebSocket upgrades, so this closes the browser attack path without tokens.
- **Rejected.** Auth tokens (friction for a local tool).
- **Costs.** A missing `Origin` is allowed (curl, tests), so any local *process* can drive the daemon; local processes are inside the trust boundary by design. GET endpoints (`/api/file`) are not origin-checked; they rely on the browser's same-origin policy blocking cross-site reads of the response.
- **Not when.** Multi-user or network-exposed services: use real authentication.
- **Try it.** `curl -X POST -H 'Origin: https://evil.example' localhost:4177/api/rescan` should return 403. Then try `Origin: http://localhost:3000`.

#### 35. A narrow desktop bridge

- **Problem.** The Electron renderer shows a web UI. Any XSS in it must not own the machine.
- **Pattern.** *Least privilege at the IPC boundary*: `contextIsolation` on, no Node in the renderer, a tiny allow-listed API, arguments validated in the main process.
- **Where in Ruah.** `electron/preload.cjs` exposes `window.ruah = { version, pickFolder, revealInFinder }` (plus a legacy `window.archmap = { version }`) through `contextBridge`. `electron/main.cjs` sets `contextIsolation: true, nodeIntegration: false` and validates IPC arguments (`ruah:reveal` only accepts absolute paths). The renderer never gets `ipcRenderer`.
- **Why here.** The desktop shell adds only what a browser cannot do (a native folder picker); everything else goes through the daemon's HTTP/WS API like in a browser.
- **Rejected.** `nodeIntegration` or exposing `ipcRenderer` directly.
- **Costs.** Every new native capability is a deliberate API addition.
- **Not when.** Never relax it; add narrow functions instead.
- **Try it.** In the Electron devtools console, check that `require` and `process` are undefined and `window.ruah` has exactly three keys.

#### 36. Path confinement

- **Problem.** Paths arrive from the viewer (`/api/file?path=`), from `architecture.json`, from agent evidence and from system files. `../../.ssh/id_rsa` must never be served.
- **Pattern.** *Canonicalize, then check containment* against the root, including symlinks.
- **Where in Ruah.** `serveFile` (`src/serve/files.ts`): rejects `..`, absolute paths and symlinks resolving outside the root; 512 KiB cap; binary → 415. `validateArchitecture` rule 5 (`relInsideRoot`). `resolveSystemPath` (`src/system/config.ts`) for `<repoId>/<path>`. `serveStatic` for viewer assets. `parseSuggestions` rejects evidence outside a repo.
- **Why here.** The daemon deliberately exposes files to the UI; confinement is what makes that safe.
- **Costs.** Easy to get wrong in the other direction (see the static-serving bug in section 3, where the check blocked everything).
- **Not when.** Never skip it for user-supplied paths.
- **Try it.** Add a symlink inside a repo pointing outside it, then request it through `/api/file`. `test/smoke.test.ts` does exactly this; read how.

#### 37. Least privilege for agents; human-in-the-loop permissions

- **Problem.** Coding agents can edit files and run commands. The user must stay in control of what actually happens.
- **Pattern.** *Least privilege* by default, with *human-in-the-loop* approval for risky actions and explicit, visible modes to relax it.
- **Where in Ruah.** No auto-approve launch flags in `src/acp/presets.ts` ("Never -a/--trust-all-tools"; no `--force`/`--always-approve`). Permission requests are relayed verbatim (`permission.request` with the agent's own `options[]`, CONTRACTS §2.2 rule 4). `AcpProcessBridge.answerPermission` refuses option ids the agent did not offer; `ClaudeSdkBridge` treats any id other than its allow options as a denial (fail closed). Modes (`default` "Manual", `acceptEdits`, `plan`, `bypassPermissions`) are chosen in the viewer, not at launch. "Always allow" in the Claude SDK bridge is rescoped to the session.
- **Why here.** The agent works in the user's real repo with the user's real credentials.
- **Costs.** More prompts in `default` mode; permission requests have no daemon-side timeout, so an unanswered one blocks the agent until cancel.
- **Not when.** Sandboxed, disposable environments (CI containers) where speed matters more than review.
- **Try it.** In `test/bridge.test.ts`, use the fake agent's `permission` scenario and answer with an option id it did not offer; `answerPermission` must return `false` and the agent must keep waiting. (The `MockBridge` accepts any id; it is a UI prop, not a security test.)

---

### F. AI and context engineering

#### 38. A deterministic, inspectable context pack

- **Problem.** The agent must know what the user clicked: the node, its files, neighbours, workflows. Ad hoc prompt building makes behaviour unpredictable and impossible to debug.
- **Pattern.** *Deterministic context construction*: a pure function from (model, selection) to prompt text, with a fixed template, fixed ordering, fixed caps, and golden tests. *Transparency*: show the user exactly what was sent.
- **Where in Ruah.** `buildContextPack(index, nodeId, root, userText)` in `src/context/pack.ts`, template and rules in CONTRACTS §3 (fixed line order, `FILE_LIMIT` 12, `DESCRIPTION_MAX` 400, `NOTES_MAX` 600, `EDGE_LIMIT` 12, whitespace collapsed). Golden tests in `test/pack.test.ts` compare byte-for-byte with `test/golden/context-api.txt`. The exact pack is sent back in `turn.started.contextPack` and served at `GET /api/context/:nodeId` ("Copy context").
- **Why here.** Predictable, cacheable and explainable prompts. When an answer is odd, the first question ("what did the agent see?") has a one-click answer.
- **Rejected.** Letting the agent search the repo from scratch (slow, unfocused); embedding file contents (blows the size budget; `resource_link`s let the agent open files itself).
- **Costs.** Template changes break goldens on purpose, so each change is reviewed.
- **Not when.** Exploratory prompts with no structured selection.
- **Try it.** Add a `owner:` line to the template, update the golden, and look at how many places needed to change (the answer should be two).

#### 39. Prompt block order: the question goes last

- **Problem.** A prompt was sent as `[text (ending with the question), resource_link, resource_link]`. The agent read the first link as part of the question: "Reply with exactly: OK" came back with the link appended.
- **Pattern.** Treat prompt layout as an interface: attachments first, instructions and the user's question last, and never put anything after the question.
- **Where in Ruah.** `buildPromptBlocks` in `src/context/pack.ts`; documented in CONTRACTS §3.3. Found and fixed in `ed9ddbf`.

```ts
// src/context/pack.ts (buildPromptBlocks)
// Links first, pack text last: the pack ends with the user's question, and
// agents join adjacent blocks, so a link right after the question reads as
// part of it (e.g. "Reply with exactly: OK[@src/app.ts](…)" got echoed).
const text: ContentBlock = { type: "text", text: pack };
if (!links) return [text];
// … one resource_link per file (FILE_LIMIT) …
return [...linkBlocks, text];
```

- **Why here.** Agents concatenate adjacent blocks; structure that looks separate in JSON is one string to the model.
- **Costs.** None worth mentioning; it is the right default.
- **Not when.** The API has explicit roles or separate fields for attachments; still, keep the question last.
- **Try it.** Reproduce the bug: swap the order back in a local branch, send "Reply with exactly: OK" on a node with files, and read the answer.

#### 40. AI output is a proposal, never a fact

- **Problem.** An agent can find cross-repo connections heuristics miss, but it can also invent them. Letting it edit `architecture.json` directly would make the map unreviewable.
- **Pattern.** *Human-in-the-loop proposals*: the model produces structured suggestions; code validates them strictly; a human accepts or rejects each one; accepted items keep their provenance. The model call is *injected*.
- **Where in Ruah.** `suggestConnections(system, runAgent)` in `src/system/suggest.ts`; prompt in `buildSuggestPrompt` (`suggest-prompt.ts`, versioned by `SUGGEST_PROMPT_VERSION`). `parseSuggestions` rejects unknown nodes, self-edges, out-of-range confidence, evidence that is malformed, outside a repo or past the end of the file, and duplicates of existing edges. `acceptSuggestion` turns one proposal into an edge with `source: "suggested"`, which survives re-scans (#23). This is library code; the "Suggest connections" UI is not wired yet.
- **Why here.** LLM output is useful where heuristics are blind, but it must not silently change the model. Injection keeps the logic testable with canned replies and provider-agnostic.
- **Rejected.** The agent editing `architecture.json` itself.
- **Costs.** Rejected suggestions are not remembered, so the agent may propose them again. Validation code grows with every new failure mode you see.
- **Not when.** The output is disposable (a draft reply the user reads anyway).
- **Try it.** Write a `runAgent` stub that returns one valid and one hallucinated edge (evidence line 99999). Call `suggestConnections` and check that exactly one survives with a rejection reason for the other.

#### 41. Conversation resume keyed per (chat, agent)

- **Problem.** Reopening a chat should continue the same agent conversation. Switching agents inside one chat must not mix sessions.
- **Pattern.** Store the external *session id per (conversation, provider)* and bind it on activation; fall back to a fresh session when resume is impossible.
- **Where in Ruah.** The chat header's internal `sessions[agentId]` (`ChatStore`). `AcpBridge.useSession(id | undefined)`: Claude SDK `resume`; ACP `session/load` when the agent advertises `loadSession` (then the SDK's TS-private `attachSession`, guarded, see `loadSession` in `src/acp/acp-bridge.ts`), else a new session. `SessionHub.bindSession` re-binds on chat switch and on re-acquire from the warm pool.
- **Why here.** Chats are the unit users think in; agent sessions are an implementation detail per provider.
- **Costs.** ACP agents without `loadSession` start fresh (the viewer still shows stored history). `attachSession` is SDK-internal and may change on upgrade.
- **Not when.** Each prompt is independent by design.
- **Try it.** Start a chat with Claude, switch to another agent, ask a question, switch back, and ask Claude what you asked before. Then read `bindSession` to see why that works.

---

### G. Scale and performance

#### 42. Warm pool with TTL and LRU eviction

- **Problem.** Agent CLIs take 1–5 s to start. Switching back to the previous agent or project is the common case and should be instant, with the session intact.
- **Pattern.** *Keep-alive cache / warm pool*: keep released resources alive for a while, bounded by a TTL and a size cap, evicting the least recently released first.
- **Where in Ruah.** `BridgePool` in `src/serve/bridge-pool.ts`, keyed by (project root, agent id): `acquire` reuses a warm bridge or creates one; `release` parks it for `DEFAULT_WARM_TTL_MS` (5 min, `RUAH_WARM_TTL_MS` overrides, 0 = stop at once); `makeRoom` evicts idle bridges oldest-release first down to `DEFAULT_MAX_LIVE_BRIDGES` (2). Unhealthy bridges are stopped, not parked. The pool keeps each bridge's merged status so a re-acquired agent is described instantly (#15).

```ts
// src/serve/bridge-pool.ts (release)
const unhealthy = entry.status.state === "error" || entry.status.state === "stopped";
if (this.options.ttlMs <= 0 || unhealthy) return this.evict(entry, unhealthy ? "not running" : "released");
this.clearTimer(entry);
entry.timer = setTimeout(() => {
  entry.timer = undefined;
  if (!entry.inUse) void this.evict(entry, "idle ttl expired");
}, this.options.ttlMs);
entry.timer.unref?.();           // ← a parked agent must not keep the daemon alive
this.makeRoom(this.options.maxLive);
```

- **Why here.** A Claude CLI costs a few hundred MB of RAM, so the pool is small; but one warm spare covers the "switch and switch back" case.
- **Rejected.** Stopping on every switch (the old behaviour, kept as TTL 0 for tests); an unbounded pool.
- **Costs.** Up to one extra idle agent process for 5 minutes. Sessions in parked agents must be re-bound to chats on re-acquire.
- **Not when.** Resources are cheap to create, or expensive to hold (licences, DB connections at a hard limit).
- **Try it.** Set `RUAH_WARM_TTL_MS=0`, switch agents back and forth, and time it. Then restore the default and repeat.

#### 43. Hot swap of per-project state (swap the unit, not the process)

- **Problem.** Opening another project used to mean restarting the daemon: seconds of delay, dropped sockets, lost warm agents.
- **Pattern.** Group everything that belongs to one tenant/project into one unit, and swap that unit at runtime behind a stable process and stable connections. *Re-rooting* the server.
- **Where in Ruah.** `SessionHub.setProject(next)` (`src/serve/session.ts`): detach the active turn (announced as cancelled at once, cancelled in the background), unsubscribe and close the old store, park the old bridge in the pool, attach the new store, then broadcast `project → architecture → chats → chat.history → agent.status`. Agent startup is not on the switch path (`activateBridge` starts it in the background; the UI sees `starting → idle`).
- **Why here.** The notes record 1–9 ms per switch measured server-side against a 300 ms target.
- **Rejected.** One daemon per project behind a proxy (port juggling, N agent processes); awaiting the agent's own cancel before switching (up to 15 s).
- **Costs.** A switch reports the running turn as `cancelled` immediately, while the real cancel finishes later (and is only used for usage accounting). Some state is still process-global: system repo roots live in a module-level map (`registerSystemRoots` in `src/system/roots.ts`).
- **Not when.** Tenants need isolation (security or crash isolation); then use separate processes.
- **Try it.** Measure `POST /api/projects/open` between two projects with `curl -w '%{time_total}'`. Then read `setProject` and list which steps are synchronous.

#### 44. Bound everything

- **Problem.** Real repos are huge, agents produce megabytes of output, and a browser can send anything.
- **Pattern.** *Explicit limits* at every boundary (a form of bulkheading): cap sizes, counts and time, and say so when a cap is hit.
- **Where in Ruah.** WS frames 1 MiB (`MAX_FRAME_BYTES`, `maxPayload`). `/api/file` 512 KiB (`MAX_FILE_BYTES`). Tool output 4096 chars with ` …[truncated]` (`OUTPUT_MAX_CHARS`). Scan walk 50,000 files (`MAX_WALK_FILES`, `truncated` flag). Cross-repo signals: `MAX_SIGNAL_FILES`, `MAX_SIGNAL_FILE_BYTES`, `MAX_REPO_BYTES`, `MAX_LINE`. Evidence ≤ 10. Context pack caps (#38). CLI calls 20 s and a bounded buffer. Recent projects capped at 50 unpinned.
- **Why here.** A local tool gets pointed at anything, including monorepos with a million files.
- **Costs.** Caps hide data; each one needs a visible signal (a flag, a suffix, a warning).
- **Not when.** Never skip; choose generous limits instead.
- **Try it.** Pick one input to your own service that has no limit today and add one, with a test that hits it.

---

### H. Process: building with AI agents

#### 45. Work packages with file ownership; spec → contract → parallel build → one integrator

- **Problem.** Several AI agents (and Lovable, and a human) built Ruah at the same time. Agents working on the same files produce conflicts and contradictory designs.
- **Pattern.** Decompose by *file ownership*: each work package owns a set of files and receives only the contract sections and reference rows it needs. Run packages in isolated git worktrees. One integrator merges and wires.
- **Where in Ruah.** PLAN.md §3.5 (packages A: ACP bridge, B: server/store/pack, C: viewer, D: scanner, E: MCP/packaging) with scope, inputs, acceptance check and dependencies. Handoff rule: "every package receives CONTRACTS.md whole plus only its BORROW.md rows; no package reads another package's code". `.claude/worktrees/` is git-ignored (`bb8d6b7`); merges appear in the log as `merge: …` (`76c179a`, `cd0824a`, `d5feeed`, `226833e`, `5dd7d1e`). Seams (#12) let packages land before their dependencies.
- **Why here.** Parallel agents without merge conflicts, and each agent's context stays small and focused.
- **Rejected.** One agent doing everything sequentially (slow); many agents on one branch (conflicts, drift).
- **Costs.** The contract must be good before work starts; the integrator becomes the bottleneck; mismatches surface at integration (the fixes in `ed9ddbf` and `02f6423` are exactly that).
- **Not when.** Small changes that touch everything; one agent is faster.
- **Try it.** For your next feature, write the package table first: files owned, inputs, acceptance check, depends on. If two packages need the same file, redraw the boundary.

#### 46. Borrow decisions (and code) from a reference implementation, with attribution

- **Problem.** Cancellation order, permission handling, usage limits and SDK quirks are hard-won knowledge. t3code (MIT) had solved many of them, but in Effect-TS.
- **Pattern.** Study a reference implementation, *port the decisions* (constants, orderings, edge cases) rather than the framework, and attribute what you adapt.
- **Where in Ruah.** `docs/BORROW.md` classifies each item as copy / adapt / read / drop, with file and line references. `THIRD_PARTY_NOTICES.md` lists every adapted file and its source (for example `src/acp/acp-bridge.ts` ← `AcpSessionRuntime.ts`, `CursorAdapter.ts`, `AcpAdapterSupport.ts`); each adapted file starts with a header comment naming its source commit (`eff44be43`).
- **Why here.** The 15 s cancel timeout, "settle pending approvals before `session/cancel`", replay filtering and root-session filtering all came from t3code and each prevented a real bug class.
- **Rejected.** Copying the Effect-TS code verbatim (would force a framework); starting from zero (re-discovering the same bugs).
- **Costs.** Attribution bookkeeping; divergence from upstream fixes over time.
- **Not when.** The licence does not allow it, or the reference solves a different problem than yours.
- **Try it.** Pick an open-source project that solved a problem you have. Write a BORROW-style table for it before writing any code.

#### 47. Verify for real, and write the design notes as you go

- **Problem.** Unit tests passed while real turns failed: the prompt text did not reach the agent, links corrupted the question, a new tab showed no model.
- **Pattern.** *Live smoke tests* against real agents and a real browser in addition to unit tests; a running *decision log* written while the context is fresh (ADR-lite).
- **Where in Ruah.** `test/smoke.test.ts` spawns the real CLI; `scripts/ws-smoke.ts` drives a turn over a real WebSocket; manual checks ran live Claude turns and browser sessions. `docs/DESIGN-NOTES.md` records pattern → where → why → rejected → cost for each decision as it landed; this document grew from it.
- **Why here.** The bugs in section 3 were found by live runs, not by the unit suite.
- **Costs.** Live tests cost tokens and time, and are not deterministic; keep them few and targeted.
- **Not when.** Never skip the live check for a user-facing path.
- **Try it.** After your next change, write three lines in a notes file: what you chose, what you rejected, what it costs. Do it for a month and reread it.

---

## 3. Anti-patterns we hit and fixed

Each entry: symptom → root cause → fix → general lesson.

| # | Symptom | Root cause | Fix | Lesson |
| --- | --- | --- | --- | --- |
| 1 | The agent answered about the node but ignored the user's question. | `buildContextPack` took the user text as an optional last parameter; the prompt handler did not pass it, and nothing complained. The golden test covered the pack builder, not the call site. | Pass `message.text` through (`ed9ddbf`). | Optional parameters on a critical path hide omissions. Test the wiring end to end, not just the pure function. |
| 2 | A second tab (or a reconnect) showed no model, modes or agent name until something changed. | `hello` was answered with `{ state }` only, and the bridge's first status event could fire before the hub subscribed, so it was lost. | Keep a merged last-known status (now `mergeStatus` per pool entry), send the full `agent.status` after `hello`, seed from `bridge.status()` (`ed9ddbf`). | Events are not state. If late joiners exist, keep a snapshot and send it on connect (#15). |
| 3 | "Reply with exactly: OK" came back as `OK[@src/app.ts](…)`. | `resource_link` blocks came after the text block, and agents concatenate adjacent blocks. | Links first, question last (`ed9ddbf`, CONTRACTS §3.3). | Prompt layout is an interface; put nothing after the question (#39). |
| 4 | Once a viewer directory existed, every static path returned 404. | The traversal guard ran `path.isAbsolute()` on the URL path, and every URL path starts with `/`. | Strip leading slashes first, then check (`71c020d`). | Security checks need a positive test through the real server, not only negative ones. |
| 5 | A rejected map edit looked like a crash; the viewer could not revert. | `architecture.save` failures were reported as `error{internal}`. | New `save_rejected` code in the contract and zod schema (`ed9ddbf`), recognized by the viewer (`30ff99d`), which drops its draft. | Error codes are part of the contract. Typed errors let clients react; strings only let them display. |
| 6 | After an agent crash, prompts were rejected as `busy`. | The prompt gate accepted only `idle`, but a crashed agent sits in `error`. | Accept prompts in `error`; the bridges restart the agent on the next prompt (`ed9ddbf`). | Every state in a state machine needs a way out. Draw the recovery edges. |
| 7 | The Jira token appeared in `ps` output while being saved. | `security add-generic-password … -w <token>` puts the secret in argv, which other processes of the same user can read. | `security -i` with the command on stdin, input sanitised, errors redacted (`02f6423`). | argv and environment are not secret channels. Use stdin, files with 0600, or the OS store (#31). |
| 8 | The viewer refused system maps; re-scans deleted edges users had edited. | The daemon's id pattern gained the `<repoId>:` prefix but the viewer's copy did not; edited scan edges kept `source: "scan"` and were replaced by the next scan. | Viewer accepts namespaced ids; drawn edges are `manual` and edited scan edges become `manual` (`02f6423`). | Duplicated validators drift (#2). When you widen a contract, grep for every copy of the rule. Provenance must be set by every writer (#23). |

Still open, found while writing this document:

- **Single-repo re-scan drops hand-drawn edges between scanned nodes.** `mergeWithExisting` (`src/scan/merge.ts`) keeps only edges touching hand-added nodes and ignores `source`, so the `manual` marking from fix 8 does not protect edges in a plain repo. The system merge gets this right. Lesson: when you introduce provenance, apply it in every merge path, not just the new one.
- **Any closing tab cancels the running turn**, even if another tab is still connected (`attachSession` close handler). Harmless with one window; surprising with two.

---

## 4. How to apply this to your own system

### Checklist

Boundaries and contracts
- [ ] Is there one written contract per boundary, and is it the only thing both sides share?
- [ ] Does every inbound boundary parse `unknown` into a typed value (schema), with a size limit?
- [ ] Do receivers ignore unknown fields and enum values, so old clients survive new servers?
- [ ] Are error codes typed and documented, so clients can react rather than just display?

External dependencies
- [ ] Is each external system (model provider, cloud, tracker) behind a port you own?
- [ ] Is foreign data translated at the edge, copying only the fields you need?
- [ ] Is there a standard protocol you could use instead of a bespoke integration?
- [ ] Can every external dependency be replaced by a fake in tests, at the process boundary?

State
- [ ] Is there exactly one source of truth for each piece of data, and is everything else a projection?
- [ ] Are writes atomic, and do readers keep the last good version when new data is invalid?
- [ ] If output is generated and also hand-edited: is generation deterministic, and does each record carry provenance?
- [ ] Is each piece of state stored where its audience and lifetime belong (repo, user, machine)?
- [ ] Can a client that connects late get a full snapshot without waiting for the next change?

Concurrency and failure
- [ ] For each shared mutable resource: who is the single writer, and what happens to a second request (reject or queue)?
- [ ] Does every long operation have cancellation, a deadline, and a restart path?
- [ ] Do retries back off, and are they limited to operations that can succeed later?
- [ ] Is every input, output and loop bounded, with a visible signal when a bound is hit?

Security
- [ ] Are secrets absent from files, argv, env of children, and logs?
- [ ] Are subprocesses started without a shell, with validated arguments and a timeout?
- [ ] Is every state-changing endpoint protected (Origin check on localhost, authentication elsewhere)?
- [ ] Are writes to external systems enumerated, explicit and confirmed?
- [ ] Are user-supplied paths canonicalized and confined, including symlinks?

AI features
- [ ] Is the context you send to the model built deterministically and shown to the user?
- [ ] Does the user's question come last in the prompt?
- [ ] Is model output validated and treated as a proposal until a human (or strict code) accepts it?
- [ ] Is the model call injected so the logic can be tested with canned replies?

Process
- [ ] Is work split by file ownership with explicit inputs and acceptance checks?
- [ ] Is there one integrator, and a live end-to-end check after each merge?
- [ ] Are decisions written down with what was rejected and what it costs?

### Decision table: if you have this force, reach for this pattern

| Force | Reach for | Ruah example |
| --- | --- | --- |
| Work must happen on the user's machine (files, logins, tools) | Local-first daemon + thin client (#1) | `archmap serve` + static viewer |
| Several teams or agents build against each other in parallel | Contract-first + seams (#2, #12) | CONTRACTS.md, `openSystemProjectNotWired` |
| Untrusted or hand-edited input | Parse at the boundary; keep last good (#3, #21) | `ClientMessageSchema`, `validateArchitecture` |
| Many providers of the same capability | Ports and Adapters + catalog/factory (#5, #6) | `AcpBridge`, `AgentCatalog` |
| Foreign data models that change without notice | Anti-corruption layer (#7) | `acp-normalize.ts`, `mapEc2` |
| A standard protocol exists | Use it; keep a port for exceptions (#8) | ACP for all but Claude |
| Slow, costly or nondeterministic dependency | Test double at the process boundary (#9) | `MockBridge`, `test/fake-agent.ts` |
| Long-running work with incremental results | Push channel + snapshot on connect (#13, #15) | `/ws`, `sendHello` |
| One resource, many requesters | Single writer; reject or serialize (#16, #19) | `BusyError`, `ProjectService.serialize` |
| Operations that can hang | Deadline + kill + restart (#17) | 15 s cancel timeout |
| Data humans review | File in the repo + watch (#20) | `architecture.json` |
| Generated data that people also edit | Deterministic generation + merge + provenance (#22, #23) | `scanRepo`, `mergeSystemWithExisting` |
| Inferences users must trust | Evidence on every inferred fact (#24) | `evidence: ["repo/path:line"]` |
| Independently owned parts, one global view | Federation + namespacing (#25) | `ruah.system.json`, `<repoId>:<nodeId>` |
| Many views of one model | Projections (#26) | `toGraph`, `buildContextPack` |
| Edits must feel instant | Optimistic UI + debounce + typed revert (#27) | `editArchitecture` |
| Many uncoordinated writers of facts | Append-only log, aggregate on read (#28) | `usage.jsonl` |
| Secrets | Delegate to the tool that has them; OS secret store; stdin (#31) | CLI logins, `Keychain` |
| Side effects on real systems | Read-only default + explicit confirmation (#33) | `CreateIssueDialog` |
| Localhost HTTP server | Loopback bind + Origin check (#34) | `originAllowed` |
| LLM output that changes data | Validate, propose, human accepts (#40) | `suggestConnections` |
| Expensive-to-start resources reused often | Warm pool with TTL + cap (#42) | `BridgePool` |
| Switching tenants/projects must be fast | Swap the per-project unit, keep the process (#43) | `SessionHub.setProject` |

---

## 5. Glossary

| Term | Meaning here |
| --- | --- |
| ACP | Agent Client Protocol: JSON-RPC 2.0 over stdio between a client (Ruah) and a coding agent. |
| Adapter | A class that implements a port for one external technology (`ClaudeSdkBridge`). |
| Anti-corruption layer | Code at the edge that translates a foreign model into your own. |
| Atomic replace | Write to a temp file, then rename over the target, so readers never see a partial file. |
| Bridge | Ruah's name for an agent adapter (`AcpBridge`). |
| Context pack | The deterministic text describing the selected node, prepended to the user's question. |
| CSRF | Cross-site request forgery: another website making the user's browser send requests to your server. |
| Daemon | The long-running local process (`archmap serve`). |
| Evidence | `path:line` references that justify an inferred edge. |
| Federation | Building one view from independently owned parts without taking ownership of them. |
| Golden test | A test comparing output byte-for-byte with a stored expected file. |
| Launcher state | The daemon running with no project open. |
| Port | An interface the core defines for something it needs from the outside. |
| Projection | A view computed from a canonical model, never stored as a source. |
| Provenance | Where a record came from (`scan`, `suggested`, `manual`). |
| Seam | A place where behaviour can be swapped without editing the caller (an injected function). |
| Single writer | Only one actor mutates a given state at a time. |
| Snapshot on connect | Sending the full current state to a new client before any deltas. |
| Turn | One prompt and everything the agent does until it stops. |
| Warm pool | Released resources kept alive for reuse, bounded by TTL and count. |
| Work package | A unit of parallel work with owned files, inputs and an acceptance check. |

## 6. Further reading

By name only; all are widely available.

- Alistair Cockburn, "Hexagonal Architecture" (Ports and Adapters).
- Eric Evans, *Domain-Driven Design* (anti-corruption layer, published language, bounded contexts).
- Gregor Hohpe and Bobby Woolf, *Enterprise Integration Patterns* (messaging, adapters, idempotent receivers).
- Martin Kleppmann, *Designing Data-Intensive Applications* (logs, derived data, consistency).
- Michael Nygard, *Release It!* (timeouts, bulkheads, circuit breakers, stability patterns).
- Erich Gamma, Richard Helm, Ralph Johnson, John Vlissides, *Design Patterns* (Observer, Strategy, Factory, Null Object's relatives).
- Martin Fowler, *Patterns of Enterprise Application Architecture*, and his articles "Event Sourcing" and "CQRS".
- Gerard Meszaros, *xUnit Test Patterns* (test doubles: fakes, stubs, mocks).
- Michael Feathers, *Working Effectively with Legacy Code* (seams).
- Alexis King, "Parse, don't validate".
- Martin Kleppmann, Adam Wiggins, Peter van Hardenberg, Mark McGranaghan, "Local-first software" (Ink & Switch).
- Google, *Site Reliability Engineering* (the chapters on handling overload and cascading failures; retries with backoff).
- The OWASP Cross-Site Request Forgery Prevention Cheat Sheet.
- The Electron documentation, "Security" checklist (context isolation, IPC validation).
