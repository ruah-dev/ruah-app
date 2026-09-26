# Ruah viewer (`ui/`)

The Ruah desktop app's user interface: a single-page app that talks only to the
local Ruah daemon (HTTP `/api/*`, WebSocket `/ws`, terminal `/ws/terminal`).
The protocol is specified in `../docs/CONTRACTS.md`; the types are mirrored in
`src/lib/contracts.ts`.

Stack: TanStack Start (SPA mode) + TanStack Router, React 19, Tailwind CSS v4,
shadcn/ui on Radix, lucide icons, xterm.js. Packages are managed with Bun
(`bun.lock`, with a 24 h minimum release age in `bunfig.toml`).

```sh
bun install
bun run dev      # Vite dev server; use `pnpm dev` at the repo root to get the daemon and Electron too
bun run build    # → .output/public (the root's `pnpm ui:build` copies it to ../viewer)
npx tsc --noEmit # typecheck (a CI gate)
```

Tests for the viewer's logic live in `test/` and run with the root's
`pnpm test` (vitest resolves `@/` to `ui/src`).

- Design tokens, palettes and themes: `src/design/`, documented in
  `../docs/design/README.md`. Components use semantic tokens only (no raw hex).
- Brand: `src/components/brand/` (logo, wordmark, the Phantom family).
- Shell: `src/components/shell/` (rail, command bar, status chips, layouts).

The viewer started as a Lovable project (`.lovable/`); see
`../THIRD_PARTY_NOTICES.md`. `AGENTS.md` here is Lovable's note for coding
agents working on a Lovable-connected copy.
