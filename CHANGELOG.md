# Changelog

All notable changes to Ruah are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/) (pre-1.0: a minor version may break
things; the notes say so).

## [Unreleased]

Everything after the 0.1.0 baseline below, built on 2026-09-26 in two waves.
Nothing has been tagged yet, so the first tagged release will contain both.

### Added

**Projects** (CONTRACTS §20)
- Home (`/`, `G H`): every project on one page, sorted by what needs you — a
  waiting permission (answer it from the card), a failed turn, cloud down, a
  crashed preview, a turn that finished while you were away, cloud degraded, an
  agent at work, uncommitted or unpushed work. Filters: All, Pinned and one per
  group. The open project's dashboard stays one click away.
- New project wizard (`⇧⌘N`; `⌘N` on the start screen): name and location with
  a live check of the folder it will create, a starting point, then options:
  `git init` and a first commit, a GitHub repository (`gh repo create`, private
  by default, the exact command shown), adding it to a multi-repo system, and a
  first prompt for the agent. Afterwards the map opens with first-run hints.
- Six offline templates: empty, Vite + React + TS, Node API (TypeScript),
  static site, pnpm monorepo, Terraform + GitHub Actions (plans, never applies).
- `ruah app new <name>` with the same library and rules, no daemon needed
  (`--template`, `--in`, `--no-git`, `--no-commit`, `--gh private|public`,
  `--gh-name`, `--system`, `--create-parent`, `--json`, `--templates`).
- Pinned projects keep the order you give them: drag a pinned row (or `Alt+↑/↓`)
  in the Advanced sidebar or All projects; `⌘1`–`⌘9`, the rail, the sidebar,
  the launchers and Home all read the daemon's order, and every window follows
  (`projects.changed`).
- Project groups (tags, e.g. a client or "Job"): set from a project's `⋯` menu;
  once two projects share one, a switcher above the Standard rail's tiles shows
  one group at a time.

**Daily use** (CONTRACTS §21)
- Settings → Features & behaviour and Cursor's limits card have a switch to let
  Ruah read the Cursor app's saved login for Cursor's plan usage;
  `ruah app usage settings [--read-app-logins on|off]` does the same, and a
  running daemon picks a change made with the CLI up.
- The Preview's command menu and custom-command dialog offer "Save to the repo"
  (`.ruah/preview.json`, off by default); `ruah app preview --remember` /
  `--save-to-repo`.
- "Suggest connections" shows the permission its agent waits for, with the time
  left and a Stop button (`POST /api/system/suggestions/cancel`), and ends after
  `RUAH_SUGGEST_TIMEOUT_MS` (default 10 minutes).
- A `.ruah/verify.json` that is only the placeholder older builds wrote on
  their own can be removed from the viewer ("Remove" / "Keep").

**Shell and layouts**
- Standard layout, one step richer: labels under the rail icons, project tiles
  (pinned first, then recent, badges for waiting, working and unread), recent
  chats under the agent panel's header, and status chips in the top bar (the
  project's cloud health, the agent's remaining limit, the live preview).
- Advanced layout: a labelled sidebar with the pages, your projects and the
  open project's chats. Switch with `⌘\`, the launcher, the rail or Settings →
  Appearance.
- The viewer reloads itself onto a newer build (`viewerBuild` in
  `/api/health`), without losing attachments or showing the resume card again.
- Polish across every page: one type scale and control kit, one row of page
  controls, empty, loading and error states that say what to do next,
  skeletons where the shape is known, pills and chips readable on every
  surface, visible focus everywhere, a crisper map (readable infrastructure
  names, lane headers above links, quiet deploy links).

**Design system** (CONTRACTS §15)
- The Ruah Design System: Teal + Indigo by default, Indigo, Sunrise and Classic
  teal palettes, dark, light and high-contrast themes; the minimap and every
  page follow the palette.
- `ruah app design palettes|tokens|check|css`: the tokens without the app, and
  a WCAG contrast check of every colour pair the pages use.
- The Phantom family: 19 poses, a ghost per agent, group scenes, empty states.

**Usage and limits** (CONTRACTS §16)
- A card per coding agent with its plan and a meter per limit window, reset
  times, on-demand spend, what the agent's own CLI recorded locally, and Ruah's
  own estimate: Claude (session and weekly windows), Cursor (included usage and
  on-demand), Kiro (credits), Grok and OpenCode (local stats).
- Usage → Limits (`/limits`), a remaining-limit segment in the agent pill,
  warnings before a limit runs out, `ruah app usage limits`,
  `GET /api/usage/agents`.

**Extensions** (CONTRACTS §17)
- Skills, MCP servers, Kiro powers, plugins and rules: a featured catalog (with
  the Claude Design MCP), add from a folder or a git URL (nothing runs on add),
  review what an extension runs before turning it on, enable per agent and per
  project, secrets in the Keychain, and "Also install into" Claude Code, Cursor
  or Kiro's own config, undone exactly on remove.
- The `/extensions` page (Installed, Discover, Per agent) and `ruah app ext`.

**Live preview** (CONTRACTS §18)
- Ruah finds how to run the project's dev server, runs it in a terminal tab and
  shows the page beside the agent with hot reload; "Ask agent to fix" on a
  crash. A locked-down webview for pages that refuse to be framed.
  `ruah app preview`.
- `pnpm dev`: Ruah itself with hot reload in the daemon, the viewer and
  Electron at once.

**macOS app** (CONTRACTS §19)
- `pnpm dist` builds `Ruah.app` and `Ruah-<version>-arm64.dmg`; a build check
  runs the packaged daemon, a real terminal and Claude's bundled CLI before the
  image is written.
- One Ruah at a time; folders from `ruah app <dir>`, `open -a`, Finder and the
  Dock open in the running window; application menu, window state, rotating
  logs, a restart offer when the backend exits.
- Agents and CLIs get your login shell's `PATH` and environment even when Ruah
  starts from the Dock; `ruah app doctor` shows what Ruah finds.

**Public repository** (CONTRACTS §22)
- README for new users, CONTRIBUTING, SECURITY (private vulnerability
  reporting, the security model), CODE_OF_CONDUCT, issue and pull request
  templates, this changelog.
- CI on every pull request and push to `main` (macOS required, Linux
  experimental): install, typecheck, build, test, viewer typecheck and build.
- Release workflow: a `v*` tag builds the macOS arm64 `.dmg` with a
  `SHA256SUMS.txt` and attaches them to a draft GitHub Release; optional
  Developer ID signing and notarization from secrets of a tag-only `release`
  environment.
- Dependabot for pnpm, bun and the pinned GitHub Actions.
- `test/repo-hygiene.test.ts`: tracked files carry no home folders, secret-shaped
  strings, signing material or files over 1 MiB; workflows stay pinned and
  least-privilege.
- `pnpm privacy:scan`: checks every object in the history (files, names, commit
  messages, refs) for private terms, home folders and secret shapes, with a
  positive control for history rewrites.
- The app ships `THIRD_PARTY_NOTICES.md` in `Contents/Resources`.

### Changed
- **Reading Cursor's saved login is opt-in** (`usage.readAppLogins` in
  `$RUAH_HOME/settings.json`, default off). While it is off the Cursor card
  shows the plan and the switch, and the app's login is not even opened.
  `RUAH_USAGE_READ_LOGINS=0|1` still overrides the saved choice.
- **No automatic writes into repositories.** Ruah writes only committable files
  (`.ruah/cloud.json`, `links.json`, `extensions.json`, `preview.json`,
  `verify.json`, a system's `suggestions.json` and `system-scan.json`), and only
  on your action, each time making sure `.ruah/.gitignore` ignores `.cache/`.
  Caches and run outputs (verify badges, criteria slices, eval specs and
  results) live in `$RUAH_HOME/projects/<id>/cache`; the old `.ruah/.cache/` and
  `.ruah/evals/` files are moved there once (files git tracks stay). A verify
  run and reading badges never write; verify after a turn runs only when the
  repo has criteria.
- The preview command you pick is remembered on this Mac
  (`$RUAH_HOME/projects/<id>/preview.json`), not in the repo.
- Verify results are kept per project; switching projects clears the badges.
- The start screen never covers an open project on a reload. Getting started
  shows only on a true first run; when that run opened a repo straight away, a
  one-time "New to Ruah?" toast points to it instead.
- Engine status reads the installed ruah toolkit's namespaces instead of
  assuming them (nothing is spawned); Guard, Optimize and Replay ask again once
  the daemon connects, and Replay is hidden without `ruah watch`.
- Tasks outside a git repository show a friendly state with the fix instead of
  the CLI's error; any other ruah failure is one readable line.
- Microcopy: one verb per action, errors that say what to do next.
- `package.json`: repository metadata, `packageManager`, license placeholder.
- `.gitignore` also covers `dist-electron/`, signing material, `.npmrc`, this
  repo's own `.ruah/` and editor files.
- Test fixtures and docs use fictional names only.

### Fixed
- A repo of a multi-repo system is not renamed while an agent turn in the
  system runs (the turn would write the old ids back): 409 in the app,
  `ruah app system rename` asks a running daemon first (`--offline` skips it).
- Exploring the bundled sample never reaches a daemon (engines, projects,
  preview, system dialogs, draw.io export).
- kubectl without a kubeconfig context is "not set up" with a harmless command
  to run, not a failing cluster.
- A crashed dev server says what happened instead of the tail of an error dump;
  kept preview output drops npm's spinner frames.
- A viewer opened with `?daemon=` keeps using that daemon after navigation; an
  element added with a palette click lands beside the others; the Repos dialog
  fits long paths.
- Keyboard and focus: Enter / Esc answer a permission only when nothing else
  can take the key; Esc that closes a menu or popover no longer dismisses a
  permission or leaves the level; dialogs give focus back to what opened them;
  terminal tabs, the terminal strip, resize handles and map links work by
  keyboard; clicking a segmented control leaves the arrow keys to the map.
- The map: a panned or zoomed map stays put and only a framed map is
  re-framed, at any window size; zoomed-out cards stay legible and drop whole
  words, not letters.
- New project: locations are taken from your home folder, never the daemon's
  working directory; GitHub names that `gh` would read as flags are refused;
  the report says "not confirmed" when `gh` printed no repository URL; a failed
  create removes only what it made; the commands `ruah app new` suggests are
  shell-quoted.
- Rail tiles and pinned `⌘1`–`⌘9` keep their order across reloads and
  switches; the cloud chip counts only resources with a health.
- Usage limits: a signed-out Claude CLI is told apart from an API key; Grok
  sessions are found in every folder; timed-out reads are aborted, not
  abandoned; Kiro shows no meters from an error.
- Desktop app: `ruah app` waits for `open -a` and reports a failed launch;
  folders from macOS reach the right instance; one dev profile per checkout;
  the daemon's own plumbing stays out of agent, tool and CLI environments.

### Security
- `POST /api/usage/settings` (turning on the Cursor login) accepts only the
  viewer this daemon serves or a client without an `Origin`; a `settings.set`
  over the WebSocket from another origin cannot change it.
- New project reads that run git or `gh`, and every `/api/usage/*` read, refuse
  cross-site requests without an `Origin`, rebound host names and foreign
  origins before running anything.
- The live preview's static server checks `Host`, never serves dot-files (also
  through symlinks) and takes a fixed URL only on a local address; preview
  actions refuse cross-site POSTs.
- Extensions: nothing runs on add, you approve exactly what was shown, and the
  secrets of local MCP servers never appear in argv, config files or logs.
- The packaged app turns off the Electron fuses the daemon does not need
  (`NODE_OPTIONS`, `--inspect`, extra `file://` privileges) and the daemon
  ignores `SIGUSR1`.
- Release signing secrets are available only to tag builds; every workflow
  write scope is guarded.

## [0.1.0] — not yet tagged

The first version: the baseline built between 2026-09-17 and 2026-09-25.
Everything later is listed under Unreleased.

### Map
- `ruah app scan` turns any repo into `architecture.json` (services down to
  folders, files and symbols); hand edits survive re-scans; on-demand drill-in
  below the stored map; a scalable canvas with an outline of the whole system.
- Infrastructure as code on the map: Terraform, Kubernetes, Kustomize, Helm,
  Ansible, Dockerfiles, docker compose and CI, with `ruah app infra`.
- Multi-repo systems (`ruah.system.json`): deterministic cross-repo signals,
  agent-suggested connections with review, status per repo
  (`ruah app system …`).
- Agents edit the map live through the `ruah_*` MCP tools.
- Export to draw.io with pages per level, workflows and technical specs.

### Agents
- Claude Code through the Claude Agent SDK, and Cursor Agent, Grok Build,
  Kiro CLI and OpenCode over the Agent Client Protocol; switch agents and
  models instantly (pre-warmed agents, a prompt queue while one starts).
- The selected element becomes deterministic, golden-tested context; ask
  without an element too; image attachments; permission cards; saved default
  model and mode per agent.
- Chats per project with resume per agent; background agents keep working
  when you switch projects; activity feed, unread badges, desktop
  notifications and `ruah app resume` / `ruah app activity`.
- Usage page: tokens and agent-reported cost per agent over time, and
  Claude's plan windows.

### Projects and workflow
- Start screen, fast project switching, pinned projects with ⌘1–9, a ⌘K
  launcher across projects, chats, elements, cloud resources and actions.
- Shell: an icon rail and a one-row command bar, a "Where you left off" card,
  the page and map view restored per project, Settings → Features & behaviour
  (every optional feature has a switch) and an optional ⌥Space launcher
  shortcut.
- Integrated terminal (node-pty, xterm.js) on every page, "Run in terminal"
  from tool calls, clickable links.
- Jira and GitHub issues on elements; ruah orchestration tasks and workflows.

### Cloud
- Read-only adapters for DigitalOcean, AWS, Google Cloud, Azure, Cloudflare,
  Vercel, Supabase, Kubernetes, Railway, Fly.io, Netlify and Hetzner through
  their own CLIs; normalized live health with a watch mode.
- Per-project cloud scope (`.ruah/cloud.json`): what belongs to this project
  and why, "looks related" suggestions, account picker
  (`ruah app cloud scope …`).

### Desktop app
- An Electron shell around the viewer (`ruah app`, `pnpm app`): a folder
  picker, Reveal in Finder, and desktop notifications when a background agent
  finishes or needs you.

### Security
- The daemon listens on loopback, checks `Origin` on state-changing requests
  and `Host` on every request (DNS rebinding), and guards the terminal
  WebSocket with a token.
- Credentials stay with each CLI's own login; the few secrets Ruah holds live
  in the macOS Keychain and are written through stdin.

[Unreleased]: https://github.com/ruah-dev/ruah-app/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ruah-dev/ruah-app/commits/main
