# Multi-repo systems (design, 2026-09-23)

Goal: map a system where each microservice lives in its own repo, show the
connections between them, and let the agent work across repos.

## Decisions (user, 2026-09-23)
1. The system definition is a `ruah.system.json` file in a folder or repo the
   user chooses (e.g. a platform/infra repo). It is meant to be committed and
   shared; repo paths are relative to the file.
2. Cross-repo connections: deterministic detection first, plus an optional
   "Suggest connections" pass by the agent whose edges the user accepts or
   rejects one by one. Hand-drawn edges survive re-scans.

## File
```json
{
  "version": 1,
  "name": "acme-platform",
  "repos": [
    { "id": "billing",  "path": "../billing-service" },
    { "id": "invoices", "path": "../invoices-api" },
    { "id": "web",      "path": "../web-app" },
    { "id": "infra",    "path": "../infra" }
  ]
}
```
Next to it: `architecture.json` for the system (the merged, namespaced map,
including accepted suggested edges and hand edits). Each repo keeps its own
`architecture.json` from `ruah app scan`, unchanged.

## Model
- Top level: one node per repo (type from its scan: frontend/service/…),
  plus shared infra (datastores, queues, externals) deduplicated across repos.
- Drill-down into a repo shows that repo's own architecture.
- Node ids: `<repoId>:<nodeId>`; paths: `<repoId>/<path>` so the file and
  context endpoints can resolve them to the right repo.
- Edge provenance: `source: "scan" | "suggested" | "manual"` so re-scans
  replace only `scan` edges.

## Deterministic cross-repo signals
- docker-compose / k8s manifests / terraform in any repo naming the other
  services (service names, images, `depends_on`, env).
- Env vars and config URLs naming another service
  (`BILLING_URL=http://billing:8080`, `*_SERVICE_HOST`).
- Same queue/topic name used by a publisher in one repo and a consumer in
  another.
- Internal packages published by one repo and depended on by another.

## Agent
- Session cwd = the selected node's repo; the other repos are passed as
  `additionalDirectories` (Claude Agent SDK), so the agent can follow a call
  across repos and edit several of them.
- ACP provider: cwd only (no additional directories in ACP 1.4) — document
  the limitation, fall back to cwd = system folder.

## UI (implemented 2026-09-24, CONTRACTS §12.9)
- Start screen: **New system…** (pick the system folder, add repos from disk
  or from GitHub, create and open).
- Project menu of a repo: **Add another repo…** turns it into a system in a
  folder you pick (the repo keeps its own map; an existing system in that
  folder gets the repos added). Of a system: **Repos…** and **Suggest
  connections…**.
- Repos tab: id, path, branch, ahead/behind, changes, elements, last scan;
  add (folder picker or GitHub), rename id, rescan, remove (files untouched).
- Connections tab: the deterministic edges with evidence, then "Suggest
  connections" on the current agent; proposals with confidence and clickable
  `file:line` evidence; Accept → `source: "suggested"` edge, Reject → never
  proposed again.
- Nothing of this is required: single-repo projects look and work as before.

## Managing systems (2026-09-24, CONTRACTS §12)
The logic lives in `src/system/*` as a library without daemon dependency;
the CLI and the daemon both call it, so everything works without the app:

```sh
ruah app system init ../platform --repo ../billing --repo ../web --name acme
ruah app system add gh:acme/invoices --system ../platform   # gh repo clone, then add
ruah app system status ../platform                          # branch, ↑↓, dirty, last scan, nodes
ruah app system signals ../platform                         # deterministic edges, zero tokens
ruah app system suggest ../platform                         # Claude, read-only → pending proposals
ruah app system suggest ../platform --accept 1 --reject 2
ruah app system rename web frontend --system ../platform
ruah app system remove invoices --system ../platform        # files untouched
```

Decisions:
- **Rename is allowed** and rewrites every stored reference (system file, map
  ids / paths / evidence, suggestions, work-item links, chats, cloud links);
  an id that is already an element of the map is refused. See §12.4.
- **Suggest connections in the app runs on the current agent as a normal
  turn** (visible in the chat, counted in usage, cancellable); the CLI takes a
  pluggable agent (`--agent claude`, or `--print-prompt` / `--reply-file` for
  any other).
- Review state (`.ruah/suggestions.json`) sits next to `ruah.system.json`
  and is meant to be committed with it; per-build facts go to
  `.ruah/system-scan.json`.
- A rescan of one repo refreshes that repo's own `architecture.json` only
  when it already has one; otherwise nothing is written into the repo.
- Repos added while an agent session is live reach Claude's additional
  directories on its next session.
