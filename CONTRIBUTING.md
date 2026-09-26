# Contributing to Ruah

Thanks for helping. Ruah is a local-first desktop app: a Node daemon and CLI
(`src/`), a React viewer (`ui/`) and a thin Electron shell (`electron/`). This
page gets you from a fresh clone to a pull request that passes CI.

Please read the [code of conduct](CODE_OF_CONDUCT.md) first. Security problems
go through [SECURITY.md](SECURITY.md), never a public issue.

## Set up

You need macOS (Apple silicon to build the `.dmg`; the daemon, CLI and tests
also run on Intel Macs, and Linux is an experimental CI target), and:

| Tool | Version | Why |
| --- | --- | --- |
| Node | 22 (`.nvmrc`) | daemon, CLI, tests |
| pnpm | 10 (`packageManager` in package.json; `corepack enable` picks it) | root dependencies |
| Bun | 1.3 | the viewer's dependencies and build |
| git | any recent | projects, tests |

Coding-agent CLIs (Claude Code is bundled; Cursor Agent, Grok, Kiro, OpenCode)
and cloud CLIs are optional: every feature that needs one stays quiet without
it, and `--mock` runs a scripted agent.

```sh
git clone https://github.com/ruah-dev/ruah-app.git
cd ruah-app
pnpm install
(cd ui && bun install)
```

## Run it

```sh
export RUAH_HOME="$HOME/.ruah-dev"  # keep dev runs out of your real ~/.ruah (recent projects, chats)
pnpm dev <some-repo> --mock          # daemon + viewer + Electron, hot reload everywhere
pnpm dev --no-electron               # same, viewer in your browser
pnpm cli help                        # the CLI from source (tsx src/cli.ts)
```

Point dev runs at a **copy** of a repo you do not mind Ruah writing
`architecture.json` and `.ruah/` into, not at client work. The README's
"Developing Ruah" section explains how the three parts reload.

## The gates (what CI runs)

```sh
pnpm typecheck && pnpm build && pnpm test      # daemon, CLI, desktop shell (build before test: the smoke test runs dist/)
cd ui && npx tsc --noEmit && bun run build     # viewer
```

Both must pass before you open a pull request. `pnpm test` also runs
`test/repo-hygiene.test.ts`: no home folders or secret-shaped strings in
tracked files, no file over 1 MiB, pinned and least-privilege workflows.

Maintainers who also work on client projects keep a private list of names that
must never land in this repository (clients, projects, cloud accounts and
resources, their user name or home folder), one per line, in a file **outside**
the repo, and point the test at it:
`RUAH_PRIVATE_TERMS_FILE="$HOME/.config/ruah/private-terms.txt" pnpm test`. When
the variable is set, a missing or empty file fails the test instead of skipping
it. `pnpm privacy:scan` checks the whole history (every branch, tag, commit
message and file name) against the same list; see "Before the history goes
public" below.

## Where things live

| Path | What |
| --- | --- |
| `src/cli.ts` | `ruah app …` / `ruah-app …` entry point |
| `src/serve/` | the daemon: HTTP + WebSocket server, session hub, map operations |
| `src/acp/` | agent bridges: Claude Agent SDK, ACP agents (Cursor, Grok, Kiro, OpenCode), mock |
| `src/scan/`, `src/expand/`, `src/context/` | repo → `architecture.json`, drill-in, the context pack sent to agents |
| `src/integrations/` | cloud providers (read-only, through their CLIs), Jira / GitHub issues, per-project cloud scope |
| `src/system/` | multi-repo systems (`ruah.system.json`) |
| `src/terminal/`, `src/preview/` | integrated terminal (node-pty), live preview of the project's dev server |
| `src/extensions/`, `src/usage/`, `src/activity/`, `src/resume/` | skills / MCP servers, usage and plan limits, activity feed, "where you left off" |
| `src/contracts/` | zod schemas for everything that crosses a boundary |
| `ui/src/` | the viewer (TanStack Start SPA, React 19, Tailwind v4, shadcn/Radix, lucide) |
| `ui/src/design/`, `ui/src/components/brand/` | design tokens and palettes, the Phantom mascots |
| `electron/` | desktop shell, preload bridge, the `ruah-app` shim |
| `scripts/macos/` | packaging checks, signing, flavors |
| `test/`, `ui/test/` | vitest suites; fixtures in `test/fixtures/` |
| `docs/` | `CONTRACTS.md` (every message, endpoint and file format), `DESIGN-NOTES.md`, `DESIGN-PATTERNS.md`, `design/` |

## How we build features

- **Contracts first.** Anything that crosses the daemon ↔ viewer, CLI or file
  boundary is specified in `docs/CONTRACTS.md` and validated with zod. A new
  endpoint, message or file format gets a new numbered section appended at the
  end of CONTRACTS.md (next free number) in the same pull request.
- **Every feature is modular.** It is a library in `src/<feature>/`, a
  `ruah app <feature> …` CLI that works without the daemon, optional in the app
  (Settings → Features & behaviour), and quiet when the tool it needs is
  missing (a hint, not an error).
- **Read-only by default** for anything outside the project: cloud and work
  integrations list and describe; writes happen only on an explicit user
  action. Never add "approve everything" flags for agents.
- **TypeScript is strict** (`strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`). No `any` escapes at boundaries: parse
  untrusted JSON defensively.
- **Viewer rules.** Semantic colour tokens only (`bg-surface-2`, `text-faint`,
  `bg-warn`, …), never raw hex in components, so every palette and theme works;
  `docs/design/README.md` has the token map. Never read `e.currentTarget`
  inside a `setState` updater (React reuses the event). Icons from lucide.
- **Tests with every change.** Pure logic gets unit tests; adapters get
  fixture JSON (`test/fixtures/integrations/`); UI logic lives in
  `ui/src/lib/*` so it can be tested from `ui/test/`.
- **Fixtures are fictional.** Use `acme-*`, `example.com`, documentation IP
  ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24), `/Users/me` and
  obviously fake tokens. Never paste output from a real account, a client's
  project or cloud resource names, and never commit screenshots of real
  accounts.
- **Third-party code.** Adapting code from another project is fine when its
  license allows it (MIT, BSD, ISC, Apache-2.0): add a header comment naming
  the source and commit, and a row in `THIRD_PARTY_NOTICES.md`.

## Commits and pull requests

- Conventional commits: `feat(scope): …`, `fix(…)`, `docs`, `refactor`,
  `test`, `chore`, `ci`. One logical change per commit; say why in the body.
- Keep pull requests focused. The template asks what changed, how you tested
  it (the gates, plus a live check for UI or daemon behaviour) and whether
  CONTRACTS.md or the README changed.
- Never commit `.env` files, tokens, `architecture.json` from a private repo,
  `release/` or other build output (`.gitignore` covers them).
- By contributing you agree that your contribution is licensed under the same
  license as the project.

## Releases (maintainers)

1. Bump `version` in `package.json`, move the "Unreleased" notes in
   `CHANGELOG.md` under the new version.
2. Tag `v<version>` on `main` and push the tag. `.github/workflows/release.yml`
   runs the gates, builds `Ruah-<version>-arm64.dmg` with `SHA256SUMS.txt` and
   attaches them to a **draft** release.
3. Check the draft (download, verify the checksum, open the app), then publish.

Signing and notarization are optional. Their secrets belong to the GitHub
Environment `release` (Settings → Environments; deployment rule: tags `v*`
only), not to repository secrets; the workflow's header lists them.

## Before the history goes public (maintainers)

`pnpm privacy:scan` (`scripts/privacy/scan-history.ts`) reads every object
reachable from any ref, so it also finds what only old commits, commit messages,
file names or other branches contain. It never prints a term, only the line of
the terms file.

```sh
# 1. Positive control, on the ORIGINAL repository: must find something (exit 0).
#    If it finds nothing, the list or the scan is wrong: do not trust step 3.
pnpm privacy:scan --repo /path/to/original --terms "$HOME/.config/ruah/private-terms.txt" --expect-hits

# 2. Rewrite a fresh mirror clone with git filter-repo: --replace-text for file
#    contents, --replace-message for commit messages, --path-rename or
#    --invert-paths for file names.

# 3. The rewritten clone must be clean (exit 0; exit 1 lists what is left).
pnpm privacy:scan --repo /path/to/rewritten --terms "$HOME/.config/ruah/private-terms.txt"
```
