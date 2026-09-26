# ASSUMPTIONS.md — decisions made instead of asking

Each entry: the assumption, why, and what changes if it is wrong. Nothing here blocks the plan.

## Inputs and environment

1. **No local t3code clone existed.** I searched `~/Projects`, `~/Downloads`, `~/Desktop`, `/tmp` and found nothing, so I cloned `https://github.com/pingdotgg/t3code.git` into `./t3code` (HEAD `eff44be4`, 2026-09-16). If you meant a different checkout (a fork, an older commit), point me at it; line numbers in BORROW.md are against this HEAD.
2. **The Lovable folder `Architect's Canvas/` is a plain export, not a git clone.** No `.git` directory. Component and file references in PLAN.md/CONTRACTS.md are against the files as exported today.
3. **The four deliverables live at the root of this working directory** (the planning workspace, one level above this repo), next to `Architect's Canvas/` and `t3code/`. Move them into the daemon repo when you create it.
4. **The daemon repo does not exist yet.** PLAN.md names it `ruah` and proposes a layout; the name is the working name from the brief.
5. **Development happens on macOS with Node 25.9 and pnpm 10.33** (what is installed here). Windows notes are included where t3code documents pitfalls, but nothing is tested on Windows.

## Agent and protocol

6. **Claude Code over ACP means `@agentclientprotocol/claude-agent-acp` 0.78.0.** The brief assumed t3code drives Claude Code over ACP; it does not (see BORROW.md §1). The older `@zed-industries/claude-code-acp` (0.16.2, last published 2026-03-26) is superseded. If you specifically want the Zed package, the client code is identical; only the preset changes.
7. **The adapter's bundled Claude binary is acceptable.** `claude-agent-acp` ships its own Claude Code binary through `@anthropic-ai/claude-agent-sdk-darwin-arm64` and does not use `~/.local/bin/claude` unless `CLAUDE_CODE_EXECUTABLE` is set. The preset passes that variable through so you can pin your installed CLI (2.1.273) if versions drift.
8. **Authentication comes from the existing Claude Code login.** The probe reported `authMethods: []` and an `_auth/status_update` with your Claude Max account, so no `authenticate` step is needed. If a machine has no login, the daemon reports `agent.status{state:"error"}` with the adapter's message; we do not implement a login flow.
9. **Node 22 is the floor for the daemon**, not Node 20 as the brief says, because the adapter declares `engines.node >= 22`. The ACP SDK itself works on 20.
10. **ACP `protocolVersion` stays 1 for the life of this project.** The SDK exposes an experimental v2 entry point; we do not use it. Pinned versions: SDK `1.4.0`, adapter `0.78.0`, exact (no caret).
11. **Phase 1 advertises no client capabilities** (`fs.readTextFile/writeTextFile: false`, `terminal: false`). The adapter then reads and writes the disk itself, which is what we want. If a prompt turn shows the adapter refusing tools without fs capabilities, flip both to `true` and implement the two handlers (path-checked read/write inside the repo root).
12. **Using SDK `ActiveSession.nextUpdate()` for streaming is preferred over a global `session/update` handler.** Unverified detail: whether registering both causes duplicate delivery. The Phase 0 spike settles it; the fallback is the notification handler plus manual routing by `sessionId`.
13. **One agent process, one ACP session, one prompt at a time.** The session persists across prompts so the agent keeps conversational memory of earlier nodes. "New session" is explicit (`session.reset`). If you prefer a fresh session per prompt for isolation, it is a one-line change but adds ~700 ms per prompt.
14. **Default mode is the adapter's `default` (ask before changes).** The demo shows a permission card on the first edit. If you want the recording to skip the card, use `--mode acceptEdits` (adds a mode flag to `serve`).
15. **Cancel timeout 15 s, then kill and respawn.** Copied from t3code. Tune after the spike.
16. **Viewer disconnect cancels the running turn in Phase 1.** Buffering and replay on reconnect is Phase 3.
17. **Context pack is text-first; `resource_link` blocks are additive.** The adapter advertises `embeddedContext: true`, but embedding file contents would blow the deterministic size budget. Links let Claude open the files itself.

## Architecture file and scanner

18. **Layout belongs in the file (`x`, `y`) and the daemon fills it when missing.** The viewer has no layout engine (hand-built SVG + absolutely positioned nodes) and adding one in Lovable is riskier than a 60-line layered layout in the daemon.
19. **Drill-down is expressed with `parent`, not with separate graphs.** The Lovable data model has `graphs: Record<string, Graph>` with `drill` links; a single node list with `parent` is simpler to scan and to edit by hand. The viewer derives levels.
20. **Workflows are ordered step lists only.** The Lovable Jira workflow has branching edges with labels ("reject", "blocked"). Phase 1 draws consecutive arrows without labels; branches are a later extension (`Workflow.transitions`).
21. **`owner`, `endpoints`, `health` are dropped from the schema.** The viewer already hides those sections when the fields are absent. They can return as optional fields without breaking anything.
22. **The scanner is heuristic and monorepo-first.** It recognises pnpm/npm/yarn workspaces, Cargo workspaces, `go.work`, docker-compose services, and the `apps/ packages/ services/` convention. Single-package repos get `module` nodes per top-level `src/` directory. Anything else yields one node for the repo root, which is still a valid demo.
23. **`--describe` runs as one prompt for all nodes**, returning JSON, under a read-only auto-permission policy, with a 3-minute timeout. Cheaper and faster than one prompt per node. If the output fails to parse, the scanner keeps the heuristic descriptions and prints the raw answer.
24. **The demo repo gets a hand-written `architecture.json`.** Phase 1 must not wait for the scanner. The `scan` command is Phase 2.

## Lovable viewer

25. **Lovable can apply the prompts in PLAN.md §5 without breaking the design.** Each prompt is scoped to named files and reuses existing components and tokens. If Lovable resists a change (for example SPA build mode), the fallback in PLAN.md §6 is to run the viewer with `bun run dev` and point it at the daemon with `?daemon=ws://127.0.0.1:4177/ws`.
26. **The viewer bundle can be produced as static files.** TanStack Start supports SPA mode; the exact config knob and output directory are confirmed in the first Lovable iteration. Until then the dev-server route above is the demo path.
27. **Browsers allow `ws://127.0.0.1` from an `https://…lovable.app` page.** Chromium and Firefox treat loopback as potentially trustworthy, so mixed-content rules do not block it. If a browser does block it, use the local dev server.
28. **Fonts load from Google Fonts** in `__root.tsx`. Offline, the stacks fall back to `ui-sans-serif` / `ui-monospace`. Acceptable for a local-first tool; self-hosting fonts is a cosmetic follow-up.
29. **Mobile layout is out of scope.** The viewer has a mobile branch (`useIsMobile`); the new agent features must not break it, but nothing is designed for it.

## Process

30. **Effort numbers are dev-days for one engineer driving coding agents**, not calendar days, and assume the contracts are frozen after your review.
31. **Multiple models will build this.** PLAN.md §3 splits the work into packages with explicit inputs (which CONTRACTS.md section, which BORROW.md rows) and acceptance checks, so each package can be handed to a different model with only those files as context.
32. **The MIT attribution approach in BORROW.md §3 is acceptable to you** (notices file + header comments). If you want zero derivation, follow BORROW.md §3.3 (about one extra day).
