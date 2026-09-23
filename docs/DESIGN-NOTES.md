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
- **Launcher state as an explicit "no project" state (null object at the edges).** `SessionHub` with `open = null`; `archmap serve` without `<repo>`.
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
