# Changelog

All notable changes to Ruah are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/) (pre-1.0: a minor version may break
things; the notes say so).

## [Unreleased]

### Added
- Repository ready to go public: README for new users, CONTRIBUTING,
  SECURITY (private vulnerability reporting, the security model), CODE_OF_CONDUCT,
  issue and pull request templates, this changelog.
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
- `package.json`: repository metadata, `packageManager`, license placeholder.
- `.gitignore` also covers `dist-electron/`, signing material, `.npmrc`, this
  repo's own `.ruah/` and editor files.
- Test fixtures and docs use fictional names only.

## [0.1.0] — not yet tagged

The first version, built between 2026-09-17 and 2026-09-26.

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
- Extensions: skills, MCP servers, Kiro powers, plugins and rules, added once
  and enabled per agent, secrets in the Keychain (`ruah app ext …`).
- Usage log and per-agent plan limits (Claude, Cursor, Kiro, Grok, OpenCode)
  with `ruah app usage limits`.

### Projects and workflow
- Start screen, fast project switching, pinned projects with ⌘1–9, a ⌘K
  launcher across projects, chats, elements, cloud resources and actions.
- Integrated terminal (node-pty, xterm.js) on every page, "Run in terminal"
  from tool calls, clickable links.
- Live preview: detects how to run the project's dev server, runs it in a
  terminal tab and shows the page next to the agent, with "Ask agent to fix"
  on a crash (`ruah app preview`).
- Jira and GitHub issues on elements; ruah orchestration tasks and workflows.

### Cloud
- Read-only adapters for DigitalOcean, AWS, Google Cloud, Azure, Cloudflare,
  Vercel, Supabase, Kubernetes, Railway, Fly.io, Netlify and Hetzner through
  their own CLIs; normalized live health with a watch mode.
- Per-project cloud scope (`.ruah/cloud.json`): what belongs to this project
  and why, "looks related" suggestions, account picker
  (`ruah app cloud scope …`).

### Desktop app and design
- macOS app (`pnpm dist` → `Ruah-<version>-arm64.dmg`): single instance,
  folders from `open -a`, Finder and the Dock, login-shell `PATH` and
  environment for agents and CLIs, `ruah app doctor`, a build check that runs
  the packaged daemon, a real pty and Claude's bundled CLI before the image is
  written, locked-down Electron fuses.
- The Ruah Design System: Teal + Indigo by default, Indigo and Sunrise
  palettes, light and dark themes, a WCAG contrast check
  (`ruah app design check`), the Phantom mascot family.
- Shell: labelled icon rail with project tiles, one-row command bar with
  status chips, recent chats, and an Advanced (sidebar) layout.
- `pnpm dev`: hot reload for daemon, viewer and Electron at once.

### Security
- The daemon listens on loopback, checks `Origin` on state-changing requests
  and `Host` on every request (DNS rebinding), and guards the terminal
  WebSocket with a token; the preview's static server never serves dot-files.
- Credentials stay with each CLI's own login; the few secrets Ruah holds live
  in the macOS Keychain and are written through stdin.

[Unreleased]: https://github.com/ruah-dev/ruah-app/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ruah-dev/ruah-app/commits/main
