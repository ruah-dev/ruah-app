# archmap

archmap is a local-first tool: a developer clicks a node on an architecture
diagram of a repository, types a short prompt, and Claude Code receives that
node as context over ACP (Agent Client Protocol); the agent's response streams
back into the diagram viewer. The daemon in this repo serves the architecture
file, builds deterministic context packs, and drives the agent over
`@agentclientprotocol/sdk`; the viewer itself is built separately in Lovable
("Architect's Canvas") and talks to the daemon over the WebSocket contract in
`docs/CONTRACTS.md`.

## Work packages (docs/PLAN.md §3.5)

| WP | Scope (files) | Depends on |
| --- | --- | --- |
| A — ACP bridge | `src/acp/*`, `test/fake-agent.ts`, `test/bridge.test.ts`, `scripts/spike-acp.ts` | nothing; publishes the `AcpBridge` interface first |
| B — Server, store, context pack | `src/contracts/*`, `src/context/*`, `src/serve/*`, `src/cli.ts` (serve only) | the `AcpBridge` interface from A (stub is enough to start) |
| C — Viewer | Lovable prompts L1–L6 (Phase 1) | B for `--mock`; A+B for the real run |
| D — Scanner | `src/scan/*`, `src/cli.ts` (scan) | B (contracts + validator); A for `--describe` |
| E — MCP + packaging | `src/mcp/*`, `scripts/sync-viewer.ts`, publish config | B |

## Commands

```sh
# desktop app: pick any repo (scanned on first open), real Claude agent
pnpm build && pnpm desktop                 # folder picker
pnpm desktop /path/to/repo                 # or pass the repo
ARCHMAP_AGENT=acp pnpm desktop /path/to/repo   # claude (default) | acp | mock

# CLI
node dist/cli.js scan /path/to/repo        # writes <repo>/architecture.json
node dist/cli.js serve /path/to/repo [--agent claude|acp] [--mock]
```

Development:

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run
pnpm build       # tsup src/cli.ts --format esm --target node22 --clean
pnpm dev         # tsx src/cli.ts
```

Spec: read `docs/PLAN.md`, `docs/CONTRACTS.md`, `docs/BORROW.md`,
`docs/ASSUMPTIONS.md` before writing code.
