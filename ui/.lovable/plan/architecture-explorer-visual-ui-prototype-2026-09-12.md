# Architecture Explorer — visual UI prototype

A Cursor-style dark workspace for exploring a system: an interactive diagram of the codebase, drill-down into any element, code preview, and an AI prompt bubble attached to whatever you clicked. All content is realistic sample data — no backend, no real repo scanning.

## Screen layout

```text
+---------------------------------------------------------------+
| top bar: repo picker | Architecture / Workflows toggle | search |
+--------+--------------------------------------+---------------+
| left   |  canvas: draggable nodes + edges     | right panel   |
| tree   |  zoom, pan, minimap, breadcrumb      | details /     |
| repo & |  click node -> popover: Drill in,    | code preview /|
| layers |  Ask agent, Open code                | agent chat    |
+--------+--------------------------------------+---------------+
```

Three resizable panes (left tree, center canvas, right inspector), collapsible sides.

## Modes

- **Architecture** — cloud/microservice view: gateway, services, queues, databases, external APIs, grouped by cluster/VPC boundaries.
- **Workflows** — process view, e.g. a Jira ticket moving Backlog to In Progress to Review to Done, with lanes, actors, and handoff arrows; also a request lifecycle workflow.

Switching is a segmented control in the top bar; canvas animates between the two graphs.

## Drill-down levels

Click a node, then "Drill in" to descend a level. Breadcrumb at the top of the canvas walks back up.

1. System — services, datastores, external systems
2. Service — internal layers: routes/controllers, handlers, domain logic, data access, config
3. Module — files and functions with call-arrows between them
4. File — code preview with line highlights, path, language, dependency list

Sample data covers a full path on both a backend service (API request in, route, validation, service, repository, DB) and a frontend app (route, page, component, hook, API client).

## Click interactions

- **Single click** — selects node, right panel shows details: description, owner, tech, endpoints, dependencies, health chips, related files.
- **Popover on node** — quick actions: Drill in, Open code, Ask agent, Copy path, Pin.
- **Ask agent** — floating prompt bubble anchored to the node, prefilled with that node's context chip ("@payments-service/routes.ts"). Sends into a chat thread in the right panel with canned assistant replies; suggested prompts like "Explain this flow", "Where are the API requests handled?".
- **Hover** — highlights connected edges and dims the rest.
- **Right panel Code tab** — file tree of that node, syntax-styled code block, line numbers, repo/branch/path header, "Open in repo" link.

## Design direction

Dark technical IDE feel: near-black layered surfaces, hairline borders, one electric accent for selection and active edges, monospace for paths and code, compact 13px UI text. Node types differentiated by icon and border tint (service, database, queue, external, frontend, file). Subtle grid canvas background, animated dashed edges for active data flow. All colors as semantic tokens in `src/styles.css`.

## Technical notes

- New routes: `/` (the explorer). Diagram is hand-built SVG + absolutely positioned React nodes (no new graph library), with pan/zoom via transform state, so nodes stay real shadcn-styled DOM elements.
- Components under `src/components/explorer/`: `DiagramCanvas`, `DiagramNode`, `DiagramEdge`, `NodePopover`, `AgentBubble`, `InspectorPanel`, `CodePreview`, `LayerBreadcrumb`, `ModeToggle`, `RepoTree`, `Minimap`.
- Graph data in `src/data/graphs.ts`: typed nodes/edges per level plus workflow graph and sample file contents.
- Uses existing shadcn primitives (resizable, popover, tabs, tooltip, scroll-area, badge, command for search) and lucide icons.
- Route `head()` gets an app-specific title and description.
