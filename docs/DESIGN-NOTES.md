# Design notes — patterns used in Ruah and why (working notes)

Raw material for the final "patterns & decisions" write-up the user asked for
(2026-09-23). Each entry: pattern → where → why → alternative rejected → cost.
Keep adding entries as work lands.

## Architecture style
- **Local-first daemon + thin client (client/server on localhost).** `src/serve/*` + viewer SPA.
  Why: the agent must run where the code is (file access, user's Claude login, git); the UI stays a static bundle that any shell (Electron, browser, Lovable preview) can host.
  Rejected: cloud backend (latency, secrets, code leaves the machine); Electron-only app (no browser/Lovable path).
  Cost: one extra process; port/origin handling (`originAllowed`, EADDRINUSE check).
- **Contract-first design (single source of coupling).** `docs/CONTRACTS.md` + zod schemas in `src/contracts/*`, mirrored in the viewer's `src/lib/contracts.ts`.
  Why: several builders (agents, Lovable, humans) work in parallel; the contract is the only thing they share.
  Rejected: shared code package (the viewer lives in another project/tool).
  Cost: the TS types exist twice; must be kept in sync by hand.

## Integration
- **Adapter / Ports-and-Adapters (hexagonal) for agents.** `AcpBridge` interface (`src/acp/bridge.ts`) with `ClaudeSdkBridge`, `AcpProcessBridge`, `MockBridge`.
  Why: swap Claude SDK / Cursor / Grok / Kiro / OpenCode without touching server or UI.
  Rejected: coding against one SDK directly.
  Cost: lowest-common-denominator events; provider specifics (skills, additional dirs) need escape hatches.
- **Factory + Strategy for provider selection.** `createBridge()` in `src/acp/index.ts`, presets in `src/acp/presets.ts`.
- **Anti-corruption layer.** `acp-normalize.ts`, the SDK event mapping in `claude-sdk-bridge.ts`: external protocol shapes are translated into our own `StreamEvent`/`ToolCallView` at the edge.
- **Standard protocol over bespoke integration.** ACP (JSON-RPC over stdio) for all non-Claude agents.
  Why: one bridge supports every ACP agent; adding an agent = adding a preset.
- **Test double / fake at the process boundary.** `MockBridge` (`--mock`) and `test/fake-agent.ts` (a real ACP agent process).
  Why: UI and protocol work never wait on a paid, slow, nondeterministic LLM.

## Communication
- **Event-driven push over WebSocket + request/response over HTTP.** `src/serve/server.ts`, `session.ts`.
  Why: streaming tokens/tool calls need push; files/context are cacheable GETs.
- **Observer / pub-sub.** `bridge.on(listener)`, `store.onChange`, `SessionHub.broadcast`.
- **State replay on connect (last-known state).** `SessionHub.lastStatus` + `agentStatusMessage()` after `hello`.
  Why: a late-joining client must not wait for the next change to know the agent/model/modes. (Bug found and fixed 2026-09-22.)
- **Single-writer concurrency: one active turn.** `BusyError`, hub's `activeTurn`.
  Why: one agent session = one conversation; avoids interleaved edits.
- **Cancellation with timeout + restart (supervisor-lite).** 15 s cancel timeout then kill/respawn in both bridges.
- **Backoff reconnect.** viewer `daemon.ts` (500 ms → 8 s).

## Data
- **File as source of truth (architecture-as-code).** `architecture.json` in the repo, watched and validated by `architecture-store.ts`.
  Why: diffable, reviewable in PRs, editable by humans, agents and the UI alike.
- **Validate at the boundary, keep last good version.** zod validation in the store and on `architecture.save`; `save_rejected` error.
- **Deterministic generation + merge of hand edits.** `src/scan/*`, `merge.ts`.
  Why: re-running the scanner must not destroy human knowledge; deterministic output makes diffs meaningful.
- **Derived views (projection).** viewer `toGraph`/`toRepoTree`/`workflowGraph` project one model into many diagrams.
- **Optimistic UI with revert.** editor saves debounced 500 ms; daemon rejects → UI reverts.
- **Append-only event log, aggregated on read (usage).** `src/usage/*`: one JSON line per finished turn in `~/.ruah/usage.jsonl` (`$RUAH_HOME`), written by the `SessionHub` from `turn_finished.usage` (one recording point, not per bridge); `GET /api/usage/summary` streams and folds the file per request; limits live in memory (`UsageLimitsService`).
  Why: every daemon (one per repo) can append without coordination (single `O_APPEND` line writes), the file is human-readable, greppable and survives crashes (a partial last line is skipped, the next append starts a fresh line); aggregation rules (buckets, ranges, null costs) can change without migrating stored data. Per-turn numbers are *differences* of the SDK's cumulative per-query counters, so the log never double-counts.
  Rejected: SQLite (native dependency + locking across daemons for a few thousand rows/month); pre-aggregated counters (lose per-turn detail, need migrations when buckets change); reading Claude's own transcripts (Claude-only, private format).
  Cost: O(n) read per request (fine at ~1 KB/day of turns; rotate/compact if it ever grows to many MB); multi-model turns are attributed to the primary model; limits are not persisted (re-read on the first request after restart).

## Projects, runtime switching and chats (CONTRACTS §5, 2026-09-23)
- **Launcher state as an explicit "no project" state (null object at the edges).** `SessionHub` with `open = null`; `archmap serve` without `<repo>`.
  Why: the app opens on a start screen instead of a blocking native folder picker; health, projects and usage work without a repo, and everything that needs a project answers one clear `409 {error:"no project open"}` (WS: `error{bad_message}`).
  Rejected: keeping "serve needs a repo" and restarting the daemon per project (seconds per switch, drops every socket and warm agent).
  Cost: every project-dependent endpoint/message has a null check.
- **Hot-swappable project context (swap the unit, not the process).** `SessionHub.setProject()` in `src/serve/session.ts`: one object holds store + watcher + listeners; a switch detaches the active turn, closes the old store, parks the old bridge, attaches the new store and broadcasts `project → architecture → chats (+history) → agent.status`. Agent startup is not on the switch path (background start, the UI sees `starting → idle`).
  Why: measured 1–9 ms per switch server-side (~2 ms HTTP round trip) against a 300 ms target.
  Rejected: one daemon per project behind a proxy (port juggling, N agent processes); awaiting the agent's own cancel before switching (up to 15 s).
  Cost: a switch reports the running turn as `cancelled` at once (the bridge's own cancel finishes later and is only used for usage accounting).
- **Warm pool / keep-alive cache for agent processes.** `BridgePool` (`src/serve/bridge-pool.ts`), keyed by (project root, agent id): the bridge the hub lets go (agent.set, project switch) stays alive 5 min (`RUAH_WARM_TTL_MS`), at most 2 live bridges, least-recently released evicted first; the pool keeps each bridge's merged last status so a re-acquired agent is described instantly.
  Why: agent CLIs take 1–5 s to start (Claude SDK init, ACP initialize + session/new); switching back to the previous agent/project is the common case and is now instant with its session intact.
  Rejected: stopping on every switch (the old behaviour; kept as TTL 0 for tests/embedders); an unbounded pool (each Claude CLI is a few hundred MB of RAM).
  Cost: up to one extra idle agent process for 5 minutes; a parked agent keeps its session, so the hub re-binds sessions to chats on re-acquire (`bindSession`).
- **Chat = header + append-only turn records, rewritten atomically.** `ChatStore` (`src/projects/chat-store.ts`): `~/.ruah/projects/<projectId>/chats/<chatId>.jsonl`, line 1 = `ChatInfo` (+ internal `sessions` per agent, `autoTitle`), then one `TurnRecord` per finished/cancelled turn; headers cached per project, turns read only for `chat.history`. Stream events are compacted on record (text chunks merged, tool calls upserted in place — what the viewer would redraw anyway).
  Why: human-readable, greppable, one file per chat (delete = unlink), the viewer redraws a turn from exactly the events it streamed; atomic temp+rename keeps the previous version on a crash.
  Rejected: SQLite (same reasons as usage); append-only with header-update lines (readers must fold; rename/title updates grow the file); storing raw per-token events (10–100× larger).
  Cost: each finished turn rewrites the chat file (fine at KB–MB sizes); two daemons writing the same chat concurrently would last-writer-win.
- **Conversation resume keyed per (chat, agent).** chat header `sessions[agentId]`; `AcpBridge.useSession(id | undefined)`: Claude SDK `resume` (falls back to a fresh session when the transcript is gone), ACP `session/load` when `agentCapabilities.loadSession` (history replay dropped; uses the SDK's TS-private `attachSession` for update routing), else a new session.
  Why: reopening a chat continues the same agent conversation; switching agents inside a chat keeps one session per agent instead of mixing them.
  Cost: ACP agents without `loadSession` start fresh (the viewer still shows stored history); `attachSession` is SDK-internal and may change on upgrade (guarded, falls back to a new session).
- **Recent list with write-temp-then-rename.** `ProjectsStore` (`src/projects/projects-store.ts`): `~/.ruah/projects.json`, pinned first then most recent, capped at 50 unpinned; a corrupt file reads as empty and is replaced on the next change; each opened project also gets `projects/<id>/project.json` so chat listings survive "forget".
- **Seam for work in flight elsewhere (injected hook).** `ProjectServiceDeps.openSystemProject` (default `openSystemProjectNotWired` → 501) for folders with `ruah.system.json`; `ServeHooks` in `run-serve.ts` is where the lead wires `src/system/*`.
  Why: projects and multi-repo are built in parallel; the seam lets both land without importing each other. Cost: one indirection.
- **Serialized opens (single-flight queue).** `ProjectService.serialize`: open/create run one at a time so two clicks cannot interleave store swaps.

## Security
- **Origin check on state-changing localhost endpoints (CSRF defence).** `POST /api/rescan`, every `POST /api/projects/*` and the `/ws` upgrade accept only loopback origins or `--allow-origin` globs (checked before the body is read).
  Why: any website open in the same browser can send requests to `127.0.0.1:4177`; without the check it could trigger actions.
  Rejected: auth tokens (friction for a local tool). Cost: cross-origin viewers (Lovable preview) need `--allow-origin`.
- **Narrow desktop bridge (contextIsolation + IPC allow-list).** `electron/preload.cjs` exposes only `window.ruah = { version, pickFolder, revealInFinder }`; `main.cjs` validates arguments (`revealInFinder` only takes absolute paths). The renderer never gets Node or `ipcRenderer`.
  Rejected: `nodeIntegration` / exposing `ipcRenderer` (any XSS in the viewer would own the machine).
- **No shell for subprocesses built from user input.** `git init` on create runs via `execFile("git", ["init","-q"], {cwd})`; the folder name is validated (no separators, not `.`/`..`, no control characters).
- **Least privilege for agents by default.** No `--force` / `--always-approve` / `--trust-all-tools` launch flags; bypass only as an explicit mode.

## Context engineering (AI-specific)
- **Prompt block order matters: the question goes last.** `buildPromptBlocks` puts `resource_link`s first and the pack text (ending with the user's question) last.
  Why: agents concatenate adjacent blocks; a link right after "Reply with exactly: OK" was read as part of the instruction and echoed back (found 2026-09-23).
- **Deterministic context pack.** `src/context/pack.ts`: the selected element's neighbourhood, files and links become the prompt context, byte-stable and golden-tested.
  Why: predictable, cacheable, explainable prompts; the user sees exactly what the agent got.
- **Human-in-the-loop permissions.** permission requests relayed verbatim to the UI; modes (ask / accept edits / plan / bypass).

## Process (how it was built with AI)
- **Work packages with file ownership** → parallel agents without merge conflicts.
- **Spec → contract → parallel implementation → integration by one owner.**
- **Port decisions, then code, from a reference implementation (t3code, MIT) with attribution.**
- **Verify for real:** live smoke turns, browser checks, not just unit tests.

## Integrations (cloud, work items, ruah — CONTRACTS.md §6)
- **Plugin registry.** `src/integrations/registry.ts`: every provider implements `Integration` (`info()` / `connect()` / `disconnect()`); cloud adapters add `sync()`, work adapters add `search()` / `get()` / `create()`. `IntegrationRegistry` is the only list of providers; `IntegrationsService` (`src/integrations/index.ts`) and the HTTP handler (`src/integrations/http.ts`, one `handleIntegrationsRequest` hook in `server.ts`) never name a provider.
  Why: adding GCP/Linear/etc. = one adapter + one `register()` line; the viewer renders whatever `GET /api/integrations` lists.
  Rejected: one module per endpoint family with provider `switch`es. Cost: the interface is lowest-common-denominator (provider extras ride in optional fields such as `regions`).
- **Adapter per provider over the provider's own CLI/API.** `cloud/digitalocean.ts` (doctl), `cloud/aws.ts` (aws), `work/github.ts` (gh), `work/jira.ts` (REST v3), `ruah.ts` (ruah CLI). Each adapter = CLI invocation table + *pure mappers* (`mapDroplets`, `mapEc2`, `mapGhIssue`, …) from untyped JSON to our `CloudResource` / `WorkItem`, read defensively (`obj/arr/str`), unit-tested with fixture JSON.
  Why: CLIs already solve auth, SSO refresh, pagination and retries; mappers are the anti-corruption layer, so provider JSON never leaks past the adapter (and fields like DB passwords or function keys are never copied).
  Rejected: AWS/DO SDKs (heavy deps, own credential handling). Cost: CLI must be installed (`cli_missing` + `setupHint`); CLI output formats can drift (mappers ignore what they do not know).
- **Credential delegation.** Cloud uses the CLI's existing login (doctl contexts, AWS profiles/SSO, `gh auth`); Ruah stores only the *selection* (`~/.ruah/integrations.json`, mode 0600, no secrets). The one token Ruah must keep (Jira) goes to the macOS Keychain via `/usr/bin/security` (service `ruah`, account `jira:<host>`), verified with `/myself` *before* it is stored. "Disconnect" clears Ruah's selection/token; it never logs a CLI out.
  Why: no secret files to leak, back up or commit; users keep one login per provider.
  Rejected: an encrypted token file (key management), env vars (leak into child processes/logs). Cost: macOS-only token storage (other platforms get a clear error); `security … -w <token>` briefly exposes the token in the process list to same-user processes (the only non-interactive `security` form).
- **Safe process execution.** `src/integrations/exec.ts`: `execFile` with an args array (no shell), 20 s timeout, bounded output, Homebrew dirs appended to `PATH` (GUI launches), user text passed as `--flag=value` (never parseable as a flag), names/profiles/globs validated by regex, error messages built without arguments and passed through `redact()` (known secrets + token-shaped patterns) before they reach the viewer.
- **Read-only by default; mutations only on explicit request.** Sync/search/status call only `list`/`describe`/`get`/`view`. The only writes: `POST /api/work/create` (issue), ruah task create/start/done/merge/cancel and workflow run. Long-running ruah executors (`task start`, `workflow run`) are launched detached with a log under `~/.ruah/projects/<id>/ruah/`; Ruah never runs `ruah init` or `--skip-gates`. All POSTs pass the `/ws` Origin check.
- **Links as code.** Element ↔ work-item links live in `<repo>/.ruah/links.json` (sorted, de-duplicated, stable 2-space JSON, rewritten only on change) so a team shares them through git and diffs stay one line per link. Cloud links are machine-specific (accounts differ per developer), so they live in `~/.ruah/projects/<id>/cloud.json` with the last sync; linking is recomputed on every read (manual > `ruah:node` tag > unique exact/normalized name match), so architecture edits show up without re-syncing.
  Rejected: storing links inside `architecture.json` (couples the diagram to one tracker; noisy diffs). Cost: two link stores with different sharing semantics.

## Planned (multi-repo, usage)
- **Namespacing** (`repoId:nodeId`) for federated models; **edge provenance** (scan/suggested/manual).
- **AI suggestions as proposals, never facts** (accept/reject per edge with evidence).
## Multi-repo systems (`src/system/*`, 2026-09-23)
- **Federation over a shared definition file (federated model, composition over aggregation).** `ruah.system.json` lists repos by relative path; `buildSystemArchitecture` composes one system map from each repo's *own* `architecture.json` (reused when valid, else scanned in memory) instead of re-modelling the repos.
  Why: each repo keeps owning its map (its own hand edits stay authoritative), the system file is small, committable and shareable; adding a repo = one line.
  Rejected: one giant scan of a parent folder (repos are not siblings in general, loses per-repo edits); a central database (not diffable/reviewable).
  Cost: a repo map edited inside the system view does not flow back into the repo's file (the system file is a projection plus system-level edits).
- **Namespacing to avoid identifier collisions.** Node ids `<repoId>:<nodeId>`, paths `<repoId>/<path>`; the repo node is the parent of the repo's top level, so drill-down = "open the repo".
  Why: two repos both have `api`/`src`; a prefix keeps ids unique, stable across scans, and reversible (`resolveSystemPath` maps a system path back to the repo on disk).
  Rejected: renumbering/suffixing duplicates (`api-2` changes meaning when repo order changes); nested files per repo (the viewer and context pack want one model).
  Cost: the id pattern (CONTRACTS.md conventions) gained an optional `<repoId>:` prefix; the viewer's own id check must accept it.
- **Deduplication by canonical key (entity resolution).** Shared infra from several repos (compose `db: postgres:16`, a `pg` dependency, a `postgres://` URL) resolves to one top-level node keyed by infra kind (`postgres`), not by the local name.
  Why: the point of the system view is to see who shares what; three "db" boxes hide that.
  Cost: two genuinely separate Postgres clusters collapse into one node (split by hand if it matters).
- **Edge provenance (`source: scan | suggested | manual`).** Every edge says where it came from; re-scans replace exactly the `scan` set and keep the rest (`src/system/merge.ts`).
  Why: deterministic regeneration and human knowledge can coexist without a diff/patch step; the UI can style or filter by provenance.
  Rejected: remembering "deleted" scan edges (tombstones) — not needed yet; a separate overlay file for hand edits (two files to keep in sync).
  Cost: a client that strips unknown fields turns scan edges into `manual` ones that re-scans can no longer replace (contract requires round-tripping).
- **Evidence-backed inference (explainable heuristics).** Cross-repo edges come only from rules that can point at a line: compose/k8s/terraform, env/config/source URLs and `*_URL`/`*_HOST` values, topic names published in one repo and consumed in another, internal package dependencies. Each edge carries `evidence: ["repo/path:line", …]`.
  Why: a map people trust must be checkable in one click; evidence also lets the user judge false positives instead of the tool hiding uncertainty.
  Rejected: AST/type-level analysis per language (slow, per-language work, still blind to config); runtime tracing (needs the system running).
  Cost: regex heuristics miss dynamic names (`topic: cfg.topic`), localhost URLs and monorepo path strings (`"apps/server/dist/bin.mjs"`); bounded file/byte caps can miss signals in huge repos.
- **AI suggestions as proposals, never facts (human-in-the-loop, dependency injection).** `suggestConnections(system, runAgent)` takes the agent call as an injected function, asks for JSON edges with file:line evidence and confidence, then validates: unknown nodes, self-edges, out-of-range confidence, evidence that is malformed / outside the repo / past the end of the file are rejected; duplicates of known edges are dropped. Accepted ones become `source: "suggested"` edges that survive re-scans.
  Why: LLM output is useful for what heuristics cannot see but must not silently change the model; injection keeps the library testable with canned replies and provider-agnostic.
  Rejected: letting the agent edit `architecture.json` directly (unreviewable, can corrupt the file).
  Cost: rejected suggestions are not remembered yet, so the agent may propose them again.
