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
- **State replay on connect (last-known state).** the last-known status per warm-pool entry (`PooledBridge.status`, merged by `mergeStatus`) sent after `hello`.
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
- **Launcher state as an explicit "no project" state (null object at the edges).** `SessionHub` with `open = null`; `ruah app serve` without `<repo>`.
  Why: the app opens on a start screen instead of a blocking native folder picker; health, projects and usage work without a repo, and everything that needs a project answers one clear `409 {error:"no project open"}` (WS: `error{bad_message}`).
  Rejected: keeping "serve needs a repo" and restarting the daemon per project (seconds per switch, drops every socket and warm agent).
  Cost: every project-dependent endpoint/message has a null check.
- **Hot-swappable project context (swap the unit, not the process).** `SessionHub.setProject()` in `src/serve/session.ts`: one object holds store + watcher + listeners; a switch detaches the active turn, closes the old store, parks the old bridge, attaches the new store and broadcasts `project → architecture → chats (+history) → agent.status`. Agent startup is not on the switch path (background start, the UI sees `starting → idle`).
  Why: measured 1–9 ms per switch server-side (~2 ms HTTP round trip) against a 300 ms target.
  Rejected: one daemon per project behind a proxy (port juggling, N agent processes); awaiting the agent's own cancel before switching (up to 15 s).
  Cost: a switch reports the running turn as `cancelled` at once (the bridge's own cancel finishes later and is only used for usage accounting).
- **Warm pool / keep-alive cache for agent processes.** `BridgePool` (`src/serve/bridge-pool.ts`), keyed by (project root, agent id): the bridge the hub lets go (agent.set, project switch) stays alive 15 min after its last use (`RUAH_WARM_TTL_MS`; was 5 min), at most 4 live bridges (`RUAH_MAX_LIVE_AGENTS`; was 2), least recently used warm one evicted first, the current one never; the pool keeps each bridge's merged last status so a re-acquired agent is described instantly.
  Why: agent CLIs take 1–5 s to start (Claude SDK init, ACP initialize + session/new); switching back to the previous agent/project is the common case and is now instant with its session intact.
  Rejected: stopping on every switch (the old behaviour; kept as TTL 0 for tests/embedders); an unbounded pool (each Claude CLI is a few hundred MB of RAM).
  Cost: up to one extra idle agent process for 5 minutes; a parked agent keeps its session, so the hub re-binds sessions to chats on re-acquire (`bindSession`).
- **Pre-warming / speculative start (switch = swap).** `SessionHub.prewarm` + `BridgePool.prewarm/start` (CONTRACTS §5.7): when the Agent · Model picker opens (all installed agents) or the pointer rests on an agent row (that one), and 3 s after a project opens (the ≤ 2 agents its chats used), the daemon starts the other agents in the background — one at a time, after the current agent is up — and parks them warm. `agent.set` to a ready one only re-points `hub.entry` (agent.status idle in the same tick); to one still starting it awaits that same start (`start` is single-flight per pooled bridge), so there is never a second process. Each agent's `warm` state rides on `agent.status` so the picker shows ready / starting dots.
  Why: switching Claude Code → Cursor Agent took 4.2 s of cursor-agent ACP cold start with an idle composer; the user decides which agent they want while looking at the picker, which is exactly the time a start needs. Measured live (2026-09-23, real agents, WS round trip on localhost): cold switch Claude → Cursor 3.7 s to idle (4.2 s reported before); pre-warmed Cursor ready 4.1 s after `agent.prewarm`, then switch 1.4 ms, back to Claude 1.0 ms, again 2.0 ms; a prompt sent right after switching to a cold OpenCode was queued and sent 0.93 s later, answered normally.
  Rejected: starting every agent at daemon start (RAM for agents never used: each CLI is 100–400 MB, Claude several hundred); pre-warming on every hover without a cap (process churn); making agent.set "optimistic" without a live process (the first prompt would still wait the full start).
  Cost: up to 3 extra agent processes for 15 min after the picker was opened; a pre-warm that needs a login fails quietly (cold + warmError, no retry for 5 min); a speculative agent is bound to the chat active when it was warmed, so opening another chat that has a stored session for it before switching costs a session switch.
- **One-slot prompt queue while an agent starts (never block typing).** A `prompt` that arrives while the current agent is `starting` (or applying its saved model / mode) is recorded as a turn at once (`turn.started{queued:true}`, user bubble + "waiting for Cursor Agent…") and sent when the agent reports idle; cancel / switch drop it without it reaching the agent. One slot, not a list: a second prompt is `busy`, like during a running turn.
  Why: the composer no longer has to be disabled during a switch; the typical "switch, then immediately ask" pays only the remaining start time. Rejected: a multi-prompt queue (turns would run back-to-back without the user seeing the first answer).
- **Saved defaults with layered precedence.** `SettingsStore` (`src/projects/settings-store.ts`, `$RUAH_HOME/settings.json`, atomic write, unknown keys kept): default agent, model and mode per agent, updated by agent.set / model.set / mode.set and by `defaults.set` from Settings → Agents. `SessionHub.configure` applies model + mode **once per agent session** (new process, reset, resumed chat) before any prompt is sent: in-session per-project choice > saved default > built-in "edit without asking" mode (`src/acp/default-modes.ts`: Claude `acceptEdits`, Cursor `agent`, OpenCode `build`, Kiro heuristic, Grok none; never bypass/trust-all).
  Why: the model reset to the agent's default after every cold start and agents asked approval for every edit; applying per session (not on every status) avoids fighting the agent's own mode changes (e.g. leaving plan mode). Rejected: passing flags at spawn (ACP has no standard flag; `--force`/`--trust-all-tools` also approve shell commands).
  Cost: a new session's first prompt waits for one set_model / set_mode round trip; ids are agent-defined, so a saved model the agent no longer offers is silently skipped.
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
  Rejected: an encrypted token file (key management), env vars (leak into child processes/logs). Cost: macOS-only token storage (other platforms get a clear error); writes use `security -i` with the command on stdin so the token never appears in a process argument list (fixed 2026-09-23; `-w <token>` in argv was visible to same-user processes).
- **Safe process execution.** `src/integrations/exec.ts`: `execFile` with an args array (no shell), 20 s timeout, bounded output, Homebrew dirs appended to `PATH` (GUI launches), user text passed as `--flag=value` (never parseable as a flag), names/profiles/globs validated by regex, error messages built without arguments and passed through `redact()` (known secrets + token-shaped patterns) before they reach the viewer.
- **Read-only by default; mutations only on explicit request.** Sync/search/status call only `list`/`describe`/`get`/`view`. The only writes: `POST /api/work/create` (issue), ruah task create/start/done/merge/cancel and workflow run. Long-running ruah executors (`task start`, `workflow run`) are launched detached with a log under `~/.ruah/projects/<id>/ruah/`; Ruah never runs `ruah init` or `--skip-gates`. All POSTs pass the `/ws` Origin check.
- **Links as code.** Element ↔ work-item links live in `<repo>/.ruah/links.json` (sorted, de-duplicated, stable 2-space JSON, rewritten only on change) so a team shares them through git and diffs stay one line per link. Cloud links are machine-specific (accounts differ per developer), so they live in `~/.ruah/projects/<id>/cloud.json` with the last sync; linking is recomputed on every read (manual > `ruah:node` tag > unique exact/normalized name match), so architecture edits show up without re-syncing.
  Rejected: storing links inside `architecture.json` (couples the diagram to one tracker; noisy diffs). Cost: two link stores with different sharing semantics.

## Earlier plans (now implemented — see the sections above and docs/DESIGN-PATTERNS.md)
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

## Drill-in and the scalable map (`src/expand/*`, `ui/src/components/editor/*`, 2026-09-23)
- **Lazy expansion / ephemeral derived data.** `architecture.json` stops at packages/modules; everything below (folders → files → symbols) is computed on demand by `GET /api/expand/:id` from the working tree and never stored (CONTRACTS §1.6). The viewer caches levels per project (`ui/src/lib/expand.ts`) and *merges* them into the map's architecture, so toGraph, breadcrumbs and the outline need no second code path.
  Why: a full-depth scan of a monorepo would be tens of thousands of nodes in a file people edit and review; the stored map stays the curated, human-owned view, while depth is always fresh from disk (the agent just edited a file → next expand shows it).
  Rejected: scanning deeper into `architecture.json` (huge diffs, stale immediately, hand edits drown); a language server / TS compiler for symbols (heavy dependency, per-language setup).
  Cost: regex parsing misses exotic syntax (nested/dynamic exports, decorators on multi-line signatures); expanded levels are read-only until pinned; a re-scan drops pinned levels (they have paths the scanner did not produce).
- **Self-describing hierarchical ids (materialised path).** Expanded ids are `<parentId>/<name>` and `<fileId>#<symbol>`; the daemon resolves any of them from a cold cache by expanding the ancestors (`Expander.locate`).
  Why: ids survive a daemon restart, a reload of the viewer (tabs on a deep level restore themselves, `lineage` rebuilds the breadcrumb) and chats (turns keep their `nodeId`); prompts and `/api/context` work for folders, files and symbols without any server-side session state.
  Rejected: opaque random ids + a server registry (lost on restart, needs GC).
  Cost: ids are long; renaming a file changes the id (like a path).
- **Cache-aside with coarse invalidation.** File list cached 4 s per repo, per-file parses keyed by `(mtime, size)`, levels keyed by the file-list instance. Peeks (`/api/expand-peek`) batch "N inside" counts for a whole level in one request.
  Why: drilling feels instant after the first read; no watcher needed.
  Cost: a new file can take up to 4 s to appear.
- **Camera outside React (imperative transform + React for structure only).** Pan/zoom mutate one `transform` on the world layer; React re-renders only when the view leaves the rendered window, crosses a level-of-detail step, or the data changes. `will-change` is set only while moving so text re-rasterises crisp at rest.
  Why: 60 fps pan/zoom on 1,000 elements / 3,000 edges (headless Chrome, 1440×900: pan 60 fps p95 17.5 ms at every zoom; zoom sweep 12 %→150 %→12 % 60 fps p95 17.5 ms).
  Rejected: camera in React state (re-renders every card per frame); a canvas/WebGL renderer (loses DOM text, a11y, selection, the existing card design).
  Cost: two sources of truth for the camera (ref + quantised state); careful effect ordering.
- **Viewport culling (virtualisation in 2-D).** Above 160 elements only cards/edges intersecting the viewport grown by 60 % are mounted; routes carry a bounding box for the edge test.
- **Level of detail (semantic zoom).** Full card (icon, name, tech in mono, "N inside" chip) ≥ 50 %; compact bar + 2-line name ≥ 20 %; tiny blocks below. Text and toolbars counter-scale through a `--inv-k` CSS variable updated in 25 % steps, and a detail switch mid-gesture waits until the wheel pauses.
  Why: at 12 % a 13 px label is 1.5 px — noise; big maps need shape and colour first, names as you approach.
  Cost: a short visual "pop" when the detail step lands.
- **Orthogonal routing with obstacle-aware gutters.** Ports spread along each side ordered by the far end; a Z route is used when it crosses no card (spatial hash), else the edge runs in the column/row gutters. Shared gutters read as light bundles.
  Rejected: full edge bundling / a layout engine (ELK/dagre: new dependency, positions would fight hand layout).
  Cost: dense graphs still form a "grid" of gutter lines; labels only on demand.
- **Progressive disclosure for focus.** Search (⌘F, with "elsewhere in the map" hits), kind/layer filters, 1-/2-hop neighbourhood, collapsible layer groups (members fold into one card, edges merged with counts), selection emphasis with everything else ≥ 60 %.
  Why: the user reported things "disappearing" at 35 %; focus should emphasise, never hide unless asked.
- **Context follows navigation.** The agent's subject is the selection, else the element whose level is open; symbols carry file + line range into the pack.

## Agents edit the map live (`src/mcp/*`, `src/serve/map-ops*.ts`, CONTRACTS §1.7, 2026-09-23)

- **Tools as the API for agents (MCP), the daemon as the single writer.** Agents change the map only through the `ruah_*` tools; every write goes through the open project's `ArchitectureStore` (validate §1.2 → atomic write → broadcast), so the viewer, the file and every tab agree, and a bad op is a tool error the agent reads and fixes ("unknown to element "Nope" — did you mean …", "has 3 elements inside; pass recursive: true") instead of a broken file. `ruah_apply` batches ops all-or-nothing into one save and one broadcast (Command + Unit of Work). Elements are referenced by id or unique name, ids are derived from names (and namespaced under a system repo parent), new elements are placed next to what they link to.
  Why: an agent editing `architecture.json` with its file tools bypasses validation, races the viewer's saves, and produces diffs the user cannot follow; tools give the agent a small typed vocabulary and the user a live, attributable stream of changes.
  Rejected: letting agents write the JSON (no validation until reload, no provenance, no live feedback); a WebSocket client inside the agent (every agent would need custom code — MCP is what they already speak).
  Cost: two transports to keep equal (in-process for the Claude SDK, stdio for ACP agents); the tool list is defined once (`src/mcp/tools.ts`) and served by both.
- **One tool definition, two transports.** Claude (Agent SDK) gets `createSdkMcpServer` in-process — no subprocess, no token, a fresh server per `query()`; ACP agents get `ruah app mcp --daemon <url>` in `session/new`/`session/load` `mcpServers`, a ~100-line hand-rolled stdio JSON-RPC server that forwards to the daemon. Tool input schemas are zod v4 shapes: the SDK's `tool()` takes them, `z.toJSONSchema` lists them for stdio.
  Rejected: `@modelcontextprotocol/sdk` as a new top-level dependency for five methods.
- **Map tools never prompt.** Claude: `canUseTool` allows `mcp__ruah__*` (not `allowedTools`, which shadows `canUseTool` and makes the SDK warn on every query). ACP: the bridge answers the agent's `session/request_permission` for `ruah-ruah_*` with allow-once itself (Cursor asked on every call).
  Why: they only touch `architecture.json`, validated by the daemon, and the user can undo a turn's map changes — prompting for each would make "draw the architecture for feature X" unusable.
- **Capability token for local IPC.** `/api/arch` and `/api/arch/ops` answer only loopback peers that send no `Origin` (never browsers) and carry a per-bridge random token (`x-ruah-token`), mapped to *(agent, project root)*; a token for a project that is no longer open gets 409. The token travels in the MCP process's environment (`RUAH_MCP_TOKEN`), not argv (`ps` shows argv).
  Why: the MCP process is not a browser, so the Origin check that guards the viewer's POSTs proves nothing here; any local process or web page could otherwise rewrite the map. Rejected: reusing the WebSocket (would need the hello/turn protocol in every agent's MCP child).
  Cost: tokens live for the daemon's life (one per bridge created); restarting the daemon invalidates running MCP children (their agents get "daemon not reachable" / 401 and the next session gets a new token).
- **Provenance "agent" (element `origin`, link `source`).** Agent-made elements and links are marked; scan and system merges keep them even when their `path` does not exist yet (an agent may draw the architecture before the code), and a scanned element keeps an existing `origin`. The viewer shows a lavender AI dot until the user presses Keep (or edits the element), which turns it into `origin: "user"` / `source: "manual"`.
  Why: re-scans must not erase what the agent drew; the user should see what is AI-made and adopt it explicitly.
  Cost: one more optional field every writer must round-trip (§1.5 rule).
- **Per-turn undo from an in-memory snapshot (Memento + three-way revert).** Before the first op of a turn the daemon keeps the map (`before`) and after each op the result (`after`); "Undo map changes" puts every element, link and workflow that differs between the two back to `before` — unless the user changed it again since (then the later edit wins and it is reported as skipped) — and drops references left dangling. Last 30 turns, this daemon's life.
  Why: whole-snapshot restore would silently discard the user's own edits made after the turn; per-turn granularity matches how people think about "what the agent just did".
  Rejected: persisting snapshots with the chat (file-sized copies per turn), git-based undo (the map is often uncommitted).
  Cost: undo is gone after a restart, and an undone turn's rows are not marked "undone" after a reload (the button then answers "nothing to undo").
- **The user's own map edits: a viewer-side undo history (2026-09-26).** Each edit this viewer saves pushes the map before it (`ui/src/lib/daemon.ts`, last 100; rapid edits of one thing — a drag, typing a description — are one step). ⌘Z / ⇧⌘Z on the map, and the "Undo" of the toast every delete shows, put a snapshot back and save it like any edit. Any change from elsewhere (an agent op, a scan, a file edit, another window, a project switch, a rejected save) clears the history. Deleting an element that has elements inside it asks first; the Delete key only deletes in Edit mode (View mode still moves, connects and renames).
  Why: a single Delete saved architecture.json at once and nothing could bring it back (the map is often uncommitted). Clearing on outside changes keeps undo from silently reverting an agent's or a scan's work — a whole-snapshot restore is only safe while this viewer was the only writer.
  Rejected: a daemon-side user undo (more protocol for what one window needs), per-op inverses (every edit helper would need one).
  Cost: undo is per window and gone on reload or when anything else touches the map.
- **Provenance on the broadcast (`by`, `changes`).** `architecture{reason:"saved"}` says who saved (`agent` + agentId + turnId, `user`, `scan`, undo) and what changed, per element. The viewer animates only agent changes and undos (new elements scale/fade in, changed ones glow lavender, removed ones fade out as a DOM ghost; reduced motion: static outline), shows "Claude added Payments · Show" when the change is off-screen, and lists the changes on the chat turn (`TurnRecord.mapChanges`, stored with the chat). The store also stops re-broadcasting its own write when the file watcher sees it (one save = one revision).

## Integrated terminal (`src/terminal/*`, `ui/src/components/terminal/*`, CONTRACTS §7, 2026-09-23)

- **Capability token + Origin check for a local RCE surface.** A terminal is a shell as the user, so `/ws/terminal` is a separate socket that needs, on top of the Origin rule every `/ws` connection has, a per-daemon random token from `GET /api/terminal/token`. The token endpoint answers only loopback peers with a loopback `Host` (DNS rebinding sends the attacker's hostname), refuses `Sec-Fetch-Site: cross-site` and any `Origin` that is not the page's own, and sends no CORS headers, so only a page the daemon itself served can read it. A non-loopback `--host` turns terminals off unless `--allow-remote-terminal`.
  Why: the Origin check alone is one header away from a shell for any web page the user visits (a missing Origin is allowed for CLI clients; a rebound hostname passes `localhost` origin rules), and `localhost` other-port origins are allowed on `/ws`. The token is the same Capability pattern as the map-ops IPC token.
  Rejected: cookies (any same-site request would carry them), putting the token in the HTML (the SPA is a static prerender served to anyone who can fetch it), reusing `/ws` (its messages are not authenticated per capability).
  Cost: a viewer on another origin (`?daemon=`, Lovable preview) has no terminal; the token rides in the socket URL's query (never logged).
- **Lazy native module with graceful degradation.** node-pty is `require`d on the first terminal request, never at startup; a load failure becomes `ready{available:false, reason}` with the fix ("run `pnpm rebuild node-pty`"), and the rest of the daemon never notices. node-pty 1.1.0 (pinned, as in t3code) ships N-API prebuilds for macOS/Windows, which load unchanged under the system Node and under Electron's Node (`ELECTRON_RUN_AS_NODE`, verified with Electron 44 / Node 24.21) — so the desktop app keeps launching the daemon with Electron's Node. The prebuilt `spawn-helper` ships without the execute bit and pnpm ≥ 10 skips install scripts, so the loader `chmod`s it (and `pnpm.onlyBuiltDependencies` allows node-pty/electron/esbuild scripts for Linux source builds).
  Rejected: launching the daemon with the system `node` (an ABI fix for a problem N-API does not have, and a second runtime to support), `@electron/rebuild` (not needed with N-API prebuilds).
  Cost: platforms without a prebuild (Linux) need a compiler at install time.
- **Scrollback ring buffer + re-attach.** The daemon owns the PTYs and keeps the last 1 MiB of output per terminal (byte-bounded, trimmed at a line break); a viewer that reloads, reconnects or opens a second window attaches and paints the replay, then the live stream. Terminal queries (cursor position, device attributes, colour queries …) are dropped from the replay so the new viewer does not answer them into the shell, and a terminal in the alternate screen (vim, top) gets a SIGWINCH nudge so it redraws. Terminals outlive project switches and are killed an hour after their project stops being the open one, and with the daemon.
  Why: the user runs dev servers and agents in these shells all day; a reload must not kill them.
  Rejected: a headless terminal emulator on the daemon serialising the screen (exact, but a second VT implementation to keep in step with the viewer's).
  Cost: a replay painted at another width can wrap differently than it was drawn.
- **Flow control by acknowledgement.** Each viewer acks the characters xterm has rendered; the PTY is paused while any attached viewer is 100 000 characters behind and resumed under 5 000 (the VS Code watermarks; t3code's OutputProtocol windows its RPC stream the same way). Without it a `cat` of a big file queues megabytes in the socket and freezes the tab.
- **xterm.js over t3code's Ghostty WASM renderer.** xterm 6 brings search, link providers, OSC 8 hyperlinks, themes and a WebGL renderer as maintained addons, all loaded on first use (dynamic import). Porting t3code's Ghostty surface (~170 KB of TypeScript coupled to its runtime) would mean owning a renderer.
- **Keys belong to whoever has focus.** While the terminal is focused, plain and Ctrl keys go to the shell (a keydown listener on the terminal stops them before the app's window listeners: Ctrl-B/Ctrl-K/Ctrl-J, Esc, Backspace/arrows on the map, Enter on a permission card); the terminal owns ⌘K (clear), ⌘F, ⌘T, ⌘± / ⌘0 and lets the app keep ⌘P, ⌘B, ⌘J, ⌘1…9. ⌃` toggles the panel everywhere.

## Shell relayout: icon rail + command bar (`ui/src/components/shell/*`, 2026-09-25)

The left sidebar had grown to ten nav items plus Projects, Chats, Outline and an agent footer, and
pages carried many buttons. Option A of the clickable mockups replaced it:

| Before | Now |
| --- | --- |
| Sidebar nav (10 items, collapsible) | 56px icon rail: Ruah mark = Dashboard; Map, Agent, Cloud, Tasks; Usage, Integrations, (Extensions slot), Settings. Status dots: agent working / waiting, unhealthy cloud of this project, running ruah tasks |
| Sidebar project header menu | Top bar project switcher (recent projects with activity badges and ⌘1–9, All projects…, Open folder, New project, New system, Add another repo / Repos / Suggest connections, Start screen) |
| Sidebar "Projects" tree (chats per project) | Launcher (Projects, Chats of every project, Recent) + the activity bell |
| Sidebar "Chats" | The agent panel's chat switcher (recent chats, New chat, All chats…); the Chats page for the full list |
| Sidebar Map outline / workflows / files / Edit palette | The Map's left drawer (⌘B, toggle in the Map's control row; Edit mode shows the palette there) |
| Sidebar "In this chat" (Agent page) | The Agent page's left drawer (⌘B) |
| ⌘K project palette + "/" element search (two palettes) | One Raycast-style launcher (`projects/CommandLauncher.tsx`, ranking in `lib/launcher.ts`): Needs you, Recent, Projects, Chats, Elements, Cloud, Pages, Actions; Tab asks the agent, ⌘Enter acts in the background |
| Agent footer + "Getting started" | Agent pill in the top bar (toggles the right panel, ⌘I); Getting started in the launcher and Settings |
| Map-only agent side panel | Right panel on every page but Agent (resizable, width remembered per project) |

Decisions:
- **Integrations stays its own rail entry**, not merged into Settings: it is a full page of
  providers and accounts; Settings links to it. **No "Infra" entry**: infrastructure-as-code lives
  on the Map (its infra layer) and there is no page or filter to point at.
- **One row of page controls.** Pages keep a single header row; secondary actions go into a ⋯ menu
  (`PageMenu`): the Map's canvas options and draw.io export, Cloud's "Show on the map", the
  Dashboard's export. Everything is also a launcher action.
- **View state per project (§13.5)**: `lib/view-restore.ts` stores the page, the map level and its
  camera, the drawer and the agent panel under the `shell` key. The URL wins on the first load of a
  window, and a switch made to show a chat keeps the chat in front.
- **"Where you left off"** (§13.4) shows only when entering a project that has news since the last
  visit (never on a first open), once per visit (`lib/resume-card.ts`).
- **Every feature stays optional** (Settings → Features & behaviour): background agents,
  notifications, the project's IaC scan option, live cloud status, the resume card, and the ⌥Space
  global launcher shortcut (desktop only, off by default).
- **Integration slots** (`shell/slots.ts`): the Extensions rail entry appears once `/extensions`
  is routed; `registerPreviewPane(Component)` adds the top bar's Preview toggle and an
  "Agent | Preview" tab on the right; `setAgentLimitHint(agentId, text)` shows a "remaining" hint in
  the agent pill (2026-09-26: a segment beside it, see below); `registerStatusItem` adds a top-bar
  status chip.
- **Shortcuts in one place**: `shell/nav.ts` `SHORTCUTS`, listed by the launcher's "Keyboard
  shortcuts" item.

## Shell, one step richer: labelled rail, projects, recent chats, status chips, Advanced layout (2026-09-26)

The rail + command bar shell turned out "a bit too simple": projects and chats were one menu
away, and the top bar said little. The user chose all four additions plus a layout toggle:

| Addition | Where | Details |
| --- | --- | --- |
| Labels under the rail icons | `shell/Rail.tsx` | 72 px rail; Settings → Appearance → Rail labels (off = the bare 56 px rail) |
| Projects in the rail | `shell/RailProjects.tsx`, `lib/rail.ts` | Avatar tiles (Arc spaces): pinned first (⌘1–9), then recent; as many as fit the height, then "+N" (All projects, with a dot when a hidden project needs you) and "+" (open folder, new project, new system). Badge: amber dot = an agent waits for you, pulsing lavender = working, a count = unread. Right-click: pin / reveal / remove |
| Recent chats in view | `shell/ChatStrip.tsx`, `lib/recent-chats.ts` | One row under the agent panel's header and the Agent page's header: the 3–5 most recently updated chats (the one in front always among them) with a status dot (working, waiting, done, failed, stopped) and bold when unread. No New of its own: the header right above has the chat switcher and New chat (⌘N). Hidden while there is nothing to switch to |
| More status in the top bar | `shell/StatusChips.tsx`, `lib/status-chips.ts` | The open project's cloud health "9 ok · 1 degraded" (§14 scope; amber / red when something is unhealthy; click → Cloud; hidden without a provider or with nothing in scope); the agent's remaining limit as a segment of the agent pill (amber ≤ 25 %, red ≤ 10 %; click → Usage); registered chips (`registerStatusItem`, e.g. the live preview's "Preview: running :5173", the viewer's own "Update ready") |
| Layout: Standard \| Advanced | `shell/layout.ts`, `shell/SidebarLists.tsx` | Advanced widens the rail into a 240 px labelled sidebar: the pages as rows (G-shortcut on hover, counts), a Projects section (pinned / recent, badges, ⌘1–9) and the open project's Chats (date groups, status dots, rename / delete), both recovered from the sidebar removed in the relayout. Toggled from Settings → Appearance, the launcher, the control at the bottom of the rail and ⌘\ |
| Auto-reload on a newer viewer build | `shell/useBuildReload.tsx`, `lib/build-reload.ts` | CONTRACTS §2.6 |

Decisions:
- **Standard stays the default.** Advanced is for people who want lists; both read the same data
  and the same shortcuts. The width animates (200 ms, none with reduced motion). Below 1100 px
  Advanced folds back to the rail (the page needs the room) and Settings says so.
- **Preferences are per user, in the viewer** (`lib/preferences.ts`, `ruah.prefs.v1`): layout and
  rail labels apply at once and reach other windows through the `storage` event. Not in the
  daemon: they are about this screen, not the project.
- **Tiles keep their slots.** The daemon sorts recents by last opened, which would make the tile you
  just clicked jump to the top. The rail keeps the previous order (`stableOrder`, saved in
  `ruah.rail.order.v1`); a project that gets a tile takes the slot of the one it pushed out; the
  open project always has one. The saved order is only rewritten once the project list has loaded
  (`projectsLoaded`): a page that just opened knows no project, then only the open one, and its
  saved ids keep their slots meanwhile.
- **Pinned projects keep their numbers.** The daemon sorts pinned projects by last opened too, so
  opening ⌘2 would make it ⌘1. The viewer keeps the pin order (`ruah.rail.pinned.v1`, settled
  against every `GET /api/projects`; a new pin goes last) and sorts `recentProjects` by it, so the
  rail, the Advanced sidebar, the launchers, the project menu and ⌘1–9 all read one order.
- **No second list of the same chats.** In Advanced the sidebar's Chats section replaces the
  strip; in Standard the strip complements the chat switcher (the full list stays in ⌘J, the
  launcher and the Chats page). One New chat control per header: the strip has none.
- **Keyboard reach.** Row actions (pin, reveal, remove; a chat's rename / delete menu) show on
  hover and on focus within the row, so Tab reaches them. Toggling the layout from the rail (its
  control, or ⌘\ with focus in it) moves the focus to the new layout's control.
- **Status chips are quiet by default**: neutral outline, colour only for a problem; nothing shows
  that has nothing to say (no provider, no limit hint, no registration). Narrow windows get the
  short form ("1 degraded").
- **Semantic tokens only** (`bg-warn`, `bg-ai`, `bg-ok`, `bg-bad`, `bg-surface-2`, `ring-sidebar`,
  `text-faint` …), so every theme and accent works unchanged.

  "Agent | Preview" tab on the right (the pane gets `onAskAgent` to bring the agent to front; the
  preview registers itself with `registerPreview()` from `components/preview/register.tsx`, called
  by `router.tsx` — a call, since ui/package.json's `"sideEffects": false` drops bare imports — and
  loads on first open); `setAgentLimitHint(agentId, text)` shows a "remaining" hint in the agent
  pill.
- **Shortcuts in one place**: `shell/nav.ts` `SHORTCUTS`, listed by the launcher's "Keyboard
  shortcuts" item.

## Live preview (`src/preview/*`, `ui/src/components/preview/*`, CONTRACTS §15, 2026-09-26)

- **The built-in static server is a local web server any page can reach.** It checks the `Host`
  header (loopback names only, like the daemon's `hostAllowed`), never serves a path with a
  dot-segment (`.env`, `.git/`; also through a symlink), logs a 404's path only for the page's own
  (`Sec-Fetch-Site: same-origin`) requests, and answers errors without details.
  Why: a DNS-rebinding page is same-origin with `http://<rebound-name>:<port>` and could read the
  project folder (`.env`, `.git/config` with a token); a cross-site `<img src>` can put any text in
  the log, and the log becomes the "Ask agent to fix" prompt.
  Rejected: an allow-list of file types (static sites serve anything), a random path prefix (the
  preview URL is shown and shared with the agent).
  Cost: a site cannot be previewed under a custom hostname (`myapp.test`) by the static server.
- **One terminal tab per preview.** A stop closes the "preview" tab; a crash leaves it (its
  output) until the next start or stop; closing the tab by hand is a stop, not a crash.
  Why: exited tabs count toward the terminal cap (32), so restarts used to end in "too many
  terminals" and a silent fall-back to a plain process without a tab.
  Cost: the output of a stopped server is only in the preview's log (`GET /api/preview/logs`).
- **The fixed URL is local http(s) only** (`.ruah/preview.json` `url`: localhost, *.localhost,
  127.x, [::1]). The file comes with the repo, and the URL is framed by the viewer
  (`allow-scripts allow-same-origin`) and fetched by the daemon: `javascript:` / `file:` or a
  remote host would be XSS, file access or a phishing page inside Ruah.
