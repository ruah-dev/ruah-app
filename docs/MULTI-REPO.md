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

## UI
- Project switcher shows the system; "+ Add repo" opens a folder picker
  (Electron) and appends to `ruah.system.json`, then scans that repo.
- "Suggest connections" lists proposed edges with evidence (file:line) and
  Accept / Reject.
