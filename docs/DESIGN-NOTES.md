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

## Security
- **Origin check on state-changing localhost endpoints (CSRF defence).** `POST /api/rescan` and the `/ws` upgrade accept only loopback origins or `--allow-origin` globs.
  Why: any website open in the same browser can send requests to `127.0.0.1:4177`; without the check it could trigger actions.
  Rejected: auth tokens (friction for a local tool). Cost: cross-origin viewers (Lovable preview) need `--allow-origin`.
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

## Planned (multi-repo, usage)
- **Namespacing** (`repoId:nodeId`) for federated models; **edge provenance** (scan/suggested/manual).
- **AI suggestions as proposals, never facts** (accept/reject per edge with evidence).
