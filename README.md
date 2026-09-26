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
- **Extensions:** skills, MCP servers, Kiro powers, plugins and rules — add once (folder, git
  URL or a curated catalog; Claude Design is listed as built into Claude Code), turn on per agent
  after seeing what it runs; Ruah injects them when a session starts, secrets stay in the
  Keychain (`ruah app ext`, the Extensions page in the sidebar).
- **Export:** draw.io with every technical spec; usage and plan limits.
- **Context switching:** agents keep working when you switch projects; an
  activity feed, unread badges and desktop notifications tell you when one
  finishes or needs permission; `ruah app resume` shows where you left off.
- **Live preview:** Ruah finds how to run the project's dev server (package.json
  scripts with the right package manager, Vite / Next / Remix / Astro /
  SvelteKit / Nuxt / Expo web / Storybook, Django / Flask / FastAPI, Rails, Go
  air, docker compose, or a plain index.html), runs it in a "preview" terminal
  tab and shows the page next to the agent (the top bar's Preview toggle): its
  edits appear with hot reload;
  a crash shows the last output and "Ask agent to fix".

Part of the [ruah](https://github.com/ruah-dev) toolkit: with the `ruah` CLI
installed this package is `ruah app`.

## Install (macOS, Apple silicon)

1. Get `Ruah-<version>-arm64.dmg` — download it, or build it from this
   checkout with `pnpm dist` (it lands in `release/`).
2. Open it and drag **Ruah** onto **Applications**.
3. Start Ruah from Applications, Spotlight or `ruah app`.

**First launch (Gatekeeper).** Builds are ad-hoc signed, not notarized by
Apple. A `.dmg` you built on this Mac opens straight away. A downloaded one is
quarantined: macOS says it cannot verify Ruah — click **Done**, then
**System Settings → Privacy & Security → Open Anyway** (once per version;
`xattr -dr com.apple.quarantine /Applications/Ruah.app` does the same). macOS
also asks once before Ruah reads a project in Documents, Desktop or Downloads.

**Daily use.**
- `ruah app ~/code/api`, `open -a Ruah ~/code/api`, or a folder dropped on the
  Dock icon opens it in the running Ruah (one Ruah at a time).
- Closing the window keeps Ruah in the Dock — agents keep working and
  notifications still arrive; **⌘Q** quits (and stops the daemon).
- Everything runs inside the app (its own runtime, Claude Code included); the
  other agents and CLIs (Cursor Agent, Grok, Kiro, OpenCode, git, gh, kubectl,
  doctl, vercel, supabase, …) are found on your login shell's `PATH`, and what
  your shell profile exports (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_USE_BEDROCK`,
  `AWS_PROFILE`, `KUBECONFIG`, proxies, `LANG`, …) reaches them too — even when
  Ruah starts from the Dock (a Dock launch waits for your shell, ≤ 5 s).
  `ruah app doctor` lists what it finds and which variables the app adds.
- No ruah toolkit? The CLI ships in the app:
  `ln -s /Applications/Ruah.app/Contents/Resources/bin/ruah-app /usr/local/bin/ruah-app`.
- Logs: **Help → Show Logs in Finder** (`~/Library/Logs/Ruah/daemon.log`).

## Run

```sh
pnpm install
pnpm app                      # build engine + viewer, open the desktop app

ruah app                      # open the desktop app (start screen): the installed Ruah.app, else this checkout's Electron
ruah app .                    # open it on the current repo (in the running app)
ruah app doctor               # which agents / git / cloud CLIs Ruah finds on your login shell's PATH (--json)
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
ruah app preview [<repo>]     # run the repo's dev server in the foreground and print its URL
ruah app preview --detect     # how it would run: every candidate (--json; --pick <id> --remember)
ruah app cloud providers      # which cloud CLIs are connected / not logged in / not installed
ruah app cloud status         # the repo's health summary (exit 1 when its resources are down; no daemon needed)
ruah app cloud list | watch   # the repo's resources · live health changes (--repo, default: cwd's repo;
                              #   --all: the whole account; --provider, --json)
ruah app cloud scope          # the repo's accounts, resources with why they belong, "looks related" (--json)
ruah app cloud scope add|remove|reset <resource-id>…      # edit .ruah/cloud.json (committable)
ruah app cloud scope accounts add|remove <provider> [<account>] [--whole]
ruah app design check         # WCAG contrast of every colour token, every palette × theme (docs/design)
ruah app design tokens --palette dusk --theme light [--json]
ruah app ext featured         # curated skills / MCP servers (GitHub, Playwright, …; Claude Design is built into Claude Code)
ruah app ext add featured:github --agent claude   # add (runs nothing) and enable for an agent
ruah app ext add ./my-skill --project             # a skill / plugin / Kiro power / rule folder, or a git URL
ruah app ext list | discover  # what Ruah injects per agent · what each agent has configured itself
ruah app help
```

`ruah-app` is the same command without the ruah toolkit. Useful environment
variables: `RUAH_AGENT` (claude | cursor | grok | kiro | opencode | mock),
`RUAH_HOME` (default `~/.ruah`), `RUAH_PORT`, `RUAH_VIEWER`,
`RUAH_CLOUD_WATCH_MS` (cloud re-sync interval while the Cloud page is open,
default 45000; `RUAH_CLOUD_WATCH=0` turns it off),
`RUAH_MAX_BACKGROUND_TURNS` (default 3), `RUAH_PREVIEW_IDLE_MS` (stop a project's
preview server once the project has been closed this long, default 600000;
`RUAH_PREVIEW=0` turns the live preview off). `RUAH_APP_DEV=1` (`ruah app` runs this
checkout's Electron even with Ruah.app installed), `RUAH_APP_BUNDLE` (which
Ruah.app `ruah app` opens), `RUAH_USER_DATA` (the desktop app's Chromium profile;
with `RUAH_HOME` set it defaults to `$RUAH_HOME/desktop`, logs to `$RUAH_HOME/logs`),
`RUAH_DEVTOOLS=1` (developer tools in a packaged build). `RUAH_HOME` separates
data, profile, single-instance lock and logs — not how folders reach the app:
macOS hands `open -a`, Finder "Open With" and Dock drops to whichever app with
that bundle id is running, so an instance on a scratch `RUAH_HOME` asks before
it opens such a folder, and a copy meant to run next to the installed app should
be a flavored build (below). `~/.ruah/settings.json` switches
features off: `"backgroundAgents": false`, `"notifications": "off"` (or
`"always"`; default `"background"`).

## Developing Ruah

```sh
pnpm install && (cd ui && bun install)
pnpm dev [<repo>] [--mock]   # the app with hot reload everywhere (below)
pnpm dev --no-electron       # same, viewer in your browser (the URL is printed)
pnpm cli <args>              # the CLI from source (tsx src/cli.ts <args>)

pnpm typecheck   # tsc --noEmit
pnpm build       # tsup → dist/cli.js (run before pnpm test: the smoke test uses dist)
pnpm test        # vitest run
pnpm ui:build    # ui/ → viewer/
pnpm desktop     # Electron on the built viewer
pnpm dist        # release/Ruah-<version>-arm64.dmg (+ release/mac-arm64/Ruah.app)
pnpm dist:app    # just the .app, no .dmg (faster)
```

`pnpm dev` (scripts/dev.ts) runs three things, so a change — yours or an agent's
working on Ruah itself — shows up in the running app at once:

| Part | How it reloads |
| --- | --- |
| daemon | `tsx watch src/cli.ts serve …` restarts on every `src/` change. The viewer's WebSockets reconnect by themselves, and in dev builds the viewer re-opens the project it had open. Terminals and preview servers of the old daemon are stopped with it. |
| viewer | the Vite dev server for `ui/` (React Fast Refresh / HMR). It proxies `/api` and `/ws*` to the daemon (`RUAH_DEV_DAEMON_URL`, ui/vite.config.ts), so the viewer stays same-origin and the terminal works. |
| desktop | Electron with `RUAH_VIEWER_URL` (load the viewer from the dev server) and `RUAH_DAEMON_URL` (use that daemon, start none); restarted when `electron/*.cjs` changes. |

Ports: the daemon from 4190, the viewer from 8080 (`--daemon-port`, `--viewer-port`,
`RUAH_DEV_DAEMON_PORT`, `RUAH_DEV_VIEWER_PORT`). Other flags go to `ruah app serve`
(`--mock`, `--agent`). `RUAH_ELECTRON_ARGS` adds Electron switches (e.g.
`--remote-debugging-port=9333`). Ctrl+C or closing the window stops everything. Use a
scratch `RUAH_HOME` to keep dev runs out of your real recent projects.

### Package

`pnpm dist` builds the daemon and the viewer, then electron-builder
(`electron-builder.config.cjs`) makes `Ruah.app` (bundle id `dev.ruah.app`) and
the `.dmg`. Before the image is written, a build check runs the packaged binary
as Node the way the app starts its daemon: `dist/cli.js`, a real node-pty
terminal and Claude's bundled CLI must all work, and the Electron fuses must be
as configured (**Security** below), or the build fails. The dev app (`pnpm app`) keeps a profile
per checkout (`Ruah Dev-<id>`), so a worktree never hands off to the installed
Ruah or to another worktree's dev app; a second launch of the same checkout
says on stderr which running instance (pid, profile) got its folder.

**Side by side.** `RUAH_APP_FLAVOR=test pnpm dist:app` builds `Ruah Test.app`
(bundle id `dev.ruah.app.test`, its own profile and logs, `Ruah-test-…` artifacts)
to try a build next to the installed Ruah: with its own bundle id macOS never
sends it your real folders, nor the installed app its test folders. Start it
with `RUAH_APP_BUNDLE="$PWD/release/mac-arm64/Ruah Test.app" ruah app …`.

**Security.** The daemon is the app's own binary running as Node
(`ELECTRON_RUN_AS_NODE`), so the RunAsNode fuse stays on — which also lets any
program already running as you start its own JavaScript under Ruah's identity
(`open --env ELECTRON_RUN_AS_NODE=1 -a Ruah --args -e …`) and use the folder
access you gave Ruah (Documents, Desktop, Downloads, external and network
volumes). With a Developer ID build that access carries over from version to
version. What the daemon does not need is off: the `NODE_OPTIONS` /
`NODE_EXTRA_CA_CERTS`, `--inspect` and extra `file://` privilege fuses, and the
daemon ignores SIGUSR1 (`--disable-sigusr1`), so nothing can attach a debugger
to the running backend. The way out is to run the daemon on a separate helper
runtime and turn RunAsNode off on the app itself; until then, grant Ruah folder
access only where you keep code.

**Signing.** Ad-hoc by default (nothing to set up). For a Developer ID build set
`RUAH_MAC_IDENTITY="Your Name (TEAMID)"` (a keychain identity) or `CSC_LINK`
(a `.p12`) + `CSC_KEY_PASSWORD`; the hardened runtime and
`electron/build/entitlements.mac.plist` then apply. It is notarized when Apple
credentials are present too: `APPLE_API_KEY` (path to the `.p8`) +
`APPLE_API_KEY_ID` + `APPLE_API_ISSUER`, or `APPLE_ID` +
`APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`, or `APPLE_KEYCHAIN_PROFILE`
(from `xcrun notarytool store-credentials`). Claude's native CLI keeps
Anthropic's signature in every build. The `.dmg` window art is
`electron/build/dmg-background.svg` (`scripts/macos/render-dmg-background.sh`).

Specs: `docs/CONTRACTS.md` (every message, endpoint and file format),
`docs/DESIGN-PATTERNS.md` (the patterns behind Ruah and why),
`docs/MULTI-REPO.md`, `docs/PLAN.md`.
