# Ruah

Ruah maps any codebase into a living architecture — services down to folders,
files and symbols — and lets coding agents work on it. Click an element, ask
about it, and the agent gets that element as context; agents edit your code
and the map itself, live. Local-first: the daemon runs next to your code, the
desktop app is a thin viewer.

- **Map:** `ruah app scan` turns a repo (or a multi-repo system,
  `ruah.system.json`) into `architecture.json`; drill in down to symbols;
  hand edits survive re-scans. Infrastructure as code (Terraform, Kubernetes,
  Kustomize, Helm, Ansible, Dockerfiles, CI) shows how it all runs and ships.
- **Agents:** Claude Code (Claude Agent SDK) and, over ACP, Cursor Agent,
  Grok Build, Kiro CLI and OpenCode — switch instantly, pick models, chats per
  project, images in prompts, map editing through the `ruah_*` tools.
- **Integrations:** DigitalOcean / AWS / GCP / Azure / Cloudflare / Vercel /
  Supabase / Kubernetes / Railway / Fly.io / Netlify / Hetzner (what runs
  where and whether it is healthy right now, live while you look), Jira / GitHub (issues on elements), ruah
  orchestration (tasks and workflows).
- **Export:** draw.io with every technical spec; usage and plan limits.
- **Context switching:** agents keep working when you switch projects; an
  activity feed, unread badges and desktop notifications tell you when one
  finishes or needs permission; `ruah app resume` shows where you left off.

Part of the [ruah](https://github.com/ruah-dev) toolkit: with the `ruah` CLI
installed this package is `ruah app`.

## Run

```sh
pnpm install
pnpm app                      # build engine + viewer, open the desktop app

ruah app                      # open the desktop app (start screen)
ruah app .                    # open it on the current repo
ruah app scan <repo>          # write <repo>/architecture.json (--no-infra: code only)
ruah app infra <repo>         # print the Terraform / k8s / Helm / Ansible / CI it finds (--json, --kind); writes nothing
ruah app serve [<repo>]       # daemon + viewer in the browser (http://127.0.0.1:4177)
ruah app export drawio <repo> --out map.drawio
ruah app system init <dir> --repo ../web --repo api=../api   # multi-repo system
ruah app system add gh:owner/name      # clone with gh, add to the system (cwd or --system)
ruah app system status [--json]        # branch, ahead/behind, dirty, last scan per repo
ruah app system signals [--json]       # deterministic cross-repo edges (zero tokens)
ruah app system suggest                # agent proposes edges; --accept/--reject <n|id>
ruah app system remove|rename|rescan <id> …
ruah app resume [<repo-or-id>]  # where you left off (no argument: every recent project)
ruah app activity --since 24h   # what agents did across projects (no daemon needed)
ruah app cloud providers      # which cloud CLIs are connected / not logged in / not installed
ruah app cloud status         # health summary (exit 1 when anything is down; no daemon needed)
ruah app cloud list | watch   # every resource · live health changes (--provider, --json, --repo)
ruah app help
```

`ruah-app` is the same command without the ruah toolkit. Useful environment
variables: `RUAH_AGENT` (claude | cursor | grok | kiro | opencode | mock),
`RUAH_HOME` (default `~/.ruah`), `RUAH_PORT`, `RUAH_VIEWER`,
`RUAH_CLOUD_WATCH_MS` (cloud re-sync interval while the Cloud page is open,
default 45000; `RUAH_CLOUD_WATCH=0` turns it off),
`RUAH_MAX_BACKGROUND_TURNS` (default 3). `~/.ruah/settings.json` switches
features off: `"backgroundAgents": false`, `"notifications": "off"` (or
`"always"`; default `"background"`).

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
