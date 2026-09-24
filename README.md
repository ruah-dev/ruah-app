# Ruah

Ruah maps any codebase into a living architecture — services down to folders,
files and symbols — and lets coding agents work on it. Click an element, ask
about it, and the agent gets that element as context; agents edit your code
and the map itself, live. Local-first: the daemon runs next to your code, the
desktop app is a thin viewer.

- **Map:** `ruah app scan` turns a repo (or a multi-repo system,
  `ruah.system.json`) into `architecture.json`; drill in down to symbols;
  hand edits survive re-scans.
- **Agents:** Claude Code (Claude Agent SDK) and, over ACP, Cursor Agent,
  Grok Build, Kiro CLI and OpenCode — switch instantly, pick models, chats per
  project, images in prompts, map editing through the `ruah_*` tools.
- **Integrations:** DigitalOcean / AWS / Vercel / Supabase / Kubernetes /
  Netlify / Hetzner Cloud (what runs where and whether it is healthy right
  now, live while you look), Jira / GitHub (issues on elements), ruah
  orchestration (tasks and workflows).
- **Export:** draw.io with every technical spec; usage and plan limits.

Part of the [ruah](https://github.com/ruah-dev) toolkit: with the `ruah` CLI
installed this package is `ruah app`.

## Run

```sh
pnpm install
pnpm app                      # build engine + viewer, open the desktop app

ruah app                      # open the desktop app (start screen)
ruah app .                    # open it on the current repo
ruah app scan <repo>          # write <repo>/architecture.json
ruah app serve [<repo>]       # daemon + viewer in the browser (http://127.0.0.1:4177)
ruah app export drawio <repo> --out map.drawio
ruah app system init <dir> --repo web=../web --repo api=../api
ruah app cloud providers      # which cloud CLIs are connected / not logged in / not installed
ruah app cloud status         # health summary (exit 1 when anything is down; no daemon needed)
ruah app cloud list | watch   # every resource · live health changes (--provider, --json, --repo)
ruah app help
```

`ruah-app` is the same command without the ruah toolkit. Useful environment
variables: `RUAH_AGENT` (claude | cursor | grok | kiro | opencode | mock),
`RUAH_HOME` (default `~/.ruah`), `RUAH_PORT`, `RUAH_VIEWER`,
`RUAH_CLOUD_WATCH_MS` (cloud re-sync interval while the Cloud page is open,
default 45000; `RUAH_CLOUD_WATCH=0` turns it off).

## Develop

```sh
pnpm typecheck   # tsc --noEmit
pnpm build       # tsup → dist/cli.js (run before pnpm test: the smoke test uses dist)
pnpm test        # vitest run
pnpm ui:build    # ui/ → viewer/
pnpm desktop     # Electron on the built viewer
```

Specs: `docs/CONTRACTS.md` (every message, endpoint and file format),
`docs/DESIGN-PATTERNS.md` (the patterns behind Ruah and why),
`docs/MULTI-REPO.md`, `docs/PLAN.md`.
