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
  doctl, vercel, supabase, …) are found on your login shell's `PATH`, even when
  Ruah starts from the Dock. `ruah app doctor` lists what it finds.
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
ruah app cloud providers      # which cloud CLIs are connected / not logged in / not installed
ruah app cloud status         # the repo's health summary (exit 1 when its resources are down; no daemon needed)
ruah app cloud list | watch   # the repo's resources · live health changes (--repo, default: cwd's repo;
                              #   --all: the whole account; --provider, --json)
ruah app cloud scope          # the repo's accounts, resources with why they belong, "looks related" (--json)
ruah app cloud scope add|remove|reset <resource-id>…      # edit .ruah/cloud.json (committable)
ruah app cloud scope accounts add|remove <provider> [<account>] [--whole]
ruah app help
```

`ruah-app` is the same command without the ruah toolkit. Useful environment
variables: `RUAH_AGENT` (claude | cursor | grok | kiro | opencode | mock),
`RUAH_HOME` (default `~/.ruah`), `RUAH_PORT`, `RUAH_VIEWER`,
`RUAH_CLOUD_WATCH_MS` (cloud re-sync interval while the Cloud page is open,
default 45000; `RUAH_CLOUD_WATCH=0` turns it off),
`RUAH_MAX_BACKGROUND_TURNS` (default 3), `RUAH_APP_DEV=1` (`ruah app` runs this
checkout's Electron even with Ruah.app installed), `RUAH_APP_BUNDLE` (which
Ruah.app `ruah app` opens), `RUAH_USER_DATA` (the desktop app's Chromium profile;
with `RUAH_HOME` set it defaults to `$RUAH_HOME/desktop`, logs to `$RUAH_HOME/logs`),
`RUAH_DEVTOOLS=1` (developer tools in a packaged build). `~/.ruah/settings.json` switches
features off: `"backgroundAgents": false`, `"notifications": "off"` (or
`"always"`; default `"background"`).

## Develop

```sh
pnpm typecheck   # tsc --noEmit
pnpm build       # tsup → dist/cli.js (run before pnpm test: the smoke test uses dist)
pnpm test        # vitest run
pnpm ui:build    # ui/ → viewer/
pnpm desktop     # Electron on the built viewer
pnpm dist        # release/Ruah-<version>-arm64.dmg (+ release/mac-arm64/Ruah.app)
pnpm dist:app    # just the .app, no .dmg (faster)
```

### Package

`pnpm dist` builds the daemon and the viewer, then electron-builder
(`electron-builder.config.cjs`) makes `Ruah.app` (bundle id `dev.ruah.app`) and
the `.dmg`. Before the image is written, a build check runs the packaged binary
as Node the way the app starts its daemon: `dist/cli.js`, a real node-pty
terminal and Claude's bundled CLI must all work, or the build fails. The dev
app (`pnpm app`) keeps its own profile (`Ruah Dev`), so it never hands off to
an installed Ruah.

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
