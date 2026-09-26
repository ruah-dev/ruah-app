# Security policy

Ruah runs coding agents, terminals and cloud CLIs on your machine, next to your
code. Security reports are welcome and taken seriously.

## Supported versions

Ruah is pre-1.0. Fixes land on `main` and ship in the next release; only the
latest release is supported.

| Version | Supported |
| --- | --- |
| latest `0.x` release | yes |
| older releases | no — please update |

## Reporting a vulnerability

**Please do not open a public issue, discussion or pull request for a security
problem.**

Report it privately through GitHub: open the repository's **Security** tab →
**Report a vulnerability** (GitHub's private vulnerability reporting). Include:

- what is affected (daemon, viewer, desktop app, CLI, a specific integration);
- the version (`ruah app --version`, or Ruah → About) and macOS version;
- steps to reproduce, or a proof of concept;
- the impact you expect (what an attacker gains, and what they need first).

What to expect: an acknowledgement within 3 working days, an assessment within
10, and a fix or mitigation plan agreed with you before anything is disclosed.
You will be credited in the release notes unless you prefer not to be.

Please test only against your own machine and your own accounts. Do not access
other people's data, and do not run denial-of-service or social-engineering
tests.

## Security model (what Ruah defends, and what it does not)

Ruah is a local tool: one person, one Mac. It has no server of its own, no
accounts and no telemetry. Knowing its boundaries helps you judge whether
something is a vulnerability.

**The daemon is a localhost web server.** `ruah app serve` (and the desktop
app) listens on `127.0.0.1` by default. State-changing HTTP endpoints and the
WebSocket accept only loopback origins (plus explicit `--allow-origin` globs),
and every request's `Host` header must be a loopback name, an IP literal or the
bind name, which defends against CSRF from websites you have open and against
DNS rebinding. Binding to another address
with `--host` turns the integrated terminal off unless you also pass
`--allow-remote-terminal`: anyone who can reach that port then gets a shell.
The live preview's static server follows the same host rules and never serves
dot-files (`.env`, `.git/`).

**Agents act with your permissions.** Claude Code, Cursor Agent, Grok, Kiro and
OpenCode run as your user in your project. Ruah never starts them with
"approve everything" flags (`--force`, `--trust-all-tools`, …); its default is
each agent's "edit without asking" mode (for Claude Code, `acceptEdits`), and
permission requests are shown to you verbatim. A mode that bypasses approvals
is always your explicit choice. Anything you allow an
agent to do is not a Ruah vulnerability.

**Credentials stay with their owners.** Cloud providers use their own CLIs'
logins (doctl, aws, gcloud, az, vercel, supabase, kubectl, …). Ruah stores only
which accounts you picked (`~/.ruah/integrations.json`, mode 0600). The few
secrets Ruah must hold (a Jira API token, extension secrets such as an MCP
server's token) go to the macOS Keychain, written through stdin so they never
appear in a process list. Integration errors pass through a redactor for
token-shaped strings before the viewer sees them. To show Cursor's included usage, Ruah reads the Cursor
app's saved login for a single GET to cursor.com (never stored or logged);
`RUAH_USAGE_READ_LOGINS=0` turns that off.

**Cloud access is read-only.** Syncs, status and "what runs where" only list and
describe resources. Ruah never creates, changes or deletes cloud resources.

**The desktop app.** The renderer has context isolation and a narrow preload
bridge (no Node, no `ipcRenderer`). The daemon is the app's own binary running
as Node, so Electron's `RunAsNode` fuse stays on; that lets any program already
running as you run JavaScript under Ruah's identity and use the folder access
you granted Ruah. The `NODE_OPTIONS`, `--inspect` and extra `file://`
privilege fuses are off, and the daemon ignores `SIGUSR1`. See README
"Security" for details; grant Ruah folder access only where you keep code.

**Builds.** Releases are built by GitHub Actions from a tag
(`.github/workflows/release.yml`) with a read-only token and pinned actions.
Signing credentials, once configured, live in a GitHub Environment that only
`v*` tag builds can enter. Until Developer ID signing and notarization are
configured, builds are ad-hoc signed, so macOS cannot vouch for who built them:
download only from this repository's Releases page. The `SHA256SUMS.txt` next
to the `.dmg` comes from the same release, so it only shows that your download
is complete and uncorrupted; it does not protect against a tampered release.

**In scope**, for example: a website or another machine reaching the daemon's
API or terminal; a crafted repository (its `architecture.json`, `.ruah/*`
files, package scripts or dev-server config) making Ruah run code or read files
without you asking; a secret written to a log, an error, a file in the repo or
a process argument; escaping the renderer sandbox.

**Out of scope**: what an agent does after you approved it; programs already
running as your user (they can read your files anyway); a daemon you bound to
a public address with `--host` and `--allow-remote-terminal`; vulnerabilities
in third-party agent CLIs or cloud CLIs themselves (report those upstream).
