# JOURNEYS.md — the product side of the map

Status: J1–J6 built 2026-09-27 (contract, screens from code, agent tools and context, the Journeys page with Line and Flow map views, business overlay, health and drift, screenshots, customer notes, sharing), see CONTRACTS.md §23; branch switching §24. Written 2026-09-27 against `main` at `43ec301`.

Ruah maps what a system **is** (services, modules, files, symbols, infrastructure, cloud). This plan adds what a customer **does** with it and **why it is built that way**: personas, the journeys they take through the app, the screens and actions of each step, the reason behind each step, and the code path that serves it. One tool for the product owner and the engineer: the why and the how stay linked, and Ruah says when they drift apart.

Companion: CONTRACTS.md (this becomes §23 once built), PLAN.md.

## 0. What already exists (and what it does not cover)

1. **`workflows` in `architecture.json`** (§1.1): `{ id, name, description?, steps: nodeId[] }`, ≥ 2 steps, every step a known node (§1.2 rule 7). Technical sequences only ("how it ships", request paths). A customer step is a screen plus an action plus a reason, not a node, so journeys do not fit this shape without breaking rule 7. **Decision: a separate file** (§2).
2. **Drill-in symbols** (§1.6) already parse route handlers (`GET /users`, `symbol.kind: "route"`) and React components. Journey steps can point at them by expanded id (`api/src/routes/transfers.ts#POST /transfers`) without storing them.
3. **No UI route detection.** `scan/detectors/entrypoints.ts` knows a package is Next.js / TanStack / React Router / Expo, but not which screens it has. Screens need a new detector (§3).
4. **Agents edit the map** through `ruah_*` MCP tools with provenance (`origin: "agent"`, lavender dot until **Keep**) and per-turn undo (§1.7). Journeys reuse all of it.
5. **Live preview** (§18) shows the dev server in an iframe or a locked-down `<webview>`: screenshots per step come from Electron's `capturePage` (§6).
6. **Context pack** (§3) is deterministic text; journeys add a bounded section (§4.3).

## 1. Vocabulary

| Term | Meaning | Bank example |
| --- | --- | --- |
| **Persona** | who uses the app, and what they are trying to get done | Retail customer: "know if I'm fine this month, pay bills fast" |
| **Journey** | one persona goal walked end to end | "Pay rent" |
| **Step** | one screen + one action + the reason it is designed that way | Home → taps **Transfer**, right below the balance |
| **Screen** | a place in the UI: a route or a named view | `/home`, `/transfer/new` |
| **Why** | the product rationale of a journey or step | Balance is the #1 reason people open the app, so it is the first thing on screen |
| **Signal** | how you know the step works | Transfer sent < 30 s from app open; drop-off at step 3 < 5 % |
| **Evidence** | what the why rests on: a customer quote, a call note, a metric | "I only open it to see if my salary landed" — interview, 2026-09-10 |
| **Touches** | the code that serves the step: map elements, files, symbols | `web:TransferForm` → `api#POST /transfers` → `ledger-db` |
| **Question** | an open product question on a step, usually left by an agent | "Should Transfer ask for a PIN under €50?" |

## 2. Contract: `product.json`

Lives next to `architecture.json` (`<repo>/product.json`; in a multi-repo system next to `ruah.system.json`, so journeys can cross repos). Versioned in git like the map: product decisions get reviewed in PRs next to the code they explain. Same conventions as CONTRACTS.md (ids, paths, unknown fields ignored).

### 2.1 Types

```ts
interface ProductFile {
  version: 1;
  personas: Persona[];
  screens: Screen[];
  journeys: Journey[];
}

interface Persona {
  id: string;
  name: string;                 // "Retail customer"
  description?: string;         // ≤ 400
  goals?: string[];             // ≤ 10, each ≤ 200
}

interface Screen {
  id: string;                   // "home", "transfer-new"
  name: string;                 // "Home"
  route?: string;               // "/home", "/transfer/new", "/accounts/:id"
  path?: string;                // file that renders it: "web/src/routes/home.tsx"
  node?: string;                // the frontend map element it belongs to: "web"
  source?: "scan" | "user" | "agent" | (string & {}); // "scan" = replaced on re-scan (§3.2)
  shot?: string;                // screenshot, path under the shots folder (§6)
}

interface Journey {
  id: string;
  name: string;                 // "Pay rent"
  persona?: string;             // persona id
  goal: string;                 // the user's words: "Pay my rent before the 1st"
  why?: string;                 // why this journey matters to the product (markdown, ≤ 2,000)
  priority?: "core" | "secondary" | "edge" | (string & {});
  steps: JourneyStep[];         // ≥ 1
  branches?: Branch[];          // alternate paths as their own journeys
  signal?: string;              // journey-level success signal
  origin?: "user" | "agent" | (string & {}); // absent = hand-written
  reviewedAt?: string;          // last time a person confirmed it matches the code (§5.4 drift)
}

interface JourneyStep {
  id: string;                   // unique inside the journey
  screen?: string;              // screen id
  action: string;               // what the user does: "Taps Transfer under the balance" (≤ 200)
  sees?: string;                // what they expect to see after (≤ 200)
  why?: string;                 // design rationale of this step (markdown, ≤ 1,000)
  signal?: string;              // ≤ 200
  touches?: string[];           // ≤ 20: map element ids, expanded ids (files, symbols), or architecture workflow ids
  evidence?: Evidence[];        // ≤ 20
  question?: string;            // open product question (≤ 400)
  origin?: "user" | "agent" | (string & {});
}

// A branch leaves the main line at `from` when `when` holds. It either jumps to another step
// of the same journey (`to`: retries, "edit amount" loops, skipping ahead) or follows another
// journey (`journey`) and optionally comes back (`rejoin`). Exactly one of `to` / `journey`.
interface Branch {
  from: string;                 // step id
  when: string;                 // "Insufficient funds", "Edits the amount"
  to?: string;                  // step id in this journey
  journey?: string;             // journey id of the alternate path
  rejoin?: string;              // with `journey`: step id in this journey where the alternate path returns
}

interface Evidence {
  quote: string;                // ≤ 600
  source?: string;              // "Interview — Ana, 2026-09-10", "Support ticket #412", "Amplitude: step 3 drop-off 18 %"
  date?: string;                // ISO 8601 date
  kind?: "opinion" | "thematic" | "stated_preference" | "past_behavior" | "past_behavior_pattern"
       | "commitment" | "observed_behavior" | "launch_data" | (string & {}); // weakest → strongest; strength 0–7 is derived, not stored
  stance?: "supports" | "contradicts" | (string & {}); // relative to the step's why; absent = supports
}
```

### 2.2 Validation

**Rejected** (the daemon keeps the last good version, like §1.2):
1. Duplicate persona / screen / journey ids; duplicate step ids inside a journey.
2. `journey.persona`, `step.screen`, `branch.journey`, `branch.from`, `branch.to`, `branch.rejoin` referencing something that does not exist.
3. A journey with no steps; a branch with both or neither of `to` / `journey`; a branch whose `journey` is its own journey; `rejoin` without `journey`.
4. Field length caps above.

**Warnings, never rejections** (code moves; the product file must survive a refactor):
5. A `touches` entry that no longer resolves (not a stored id, not an architecture workflow, not expandable from the working tree) → **broken link** (§5.4).
6. A `screen.path` that does not exist.

Warnings go out with every broadcast (`product{warnings}`) and feed the gaps panel.

### 2.3 Example (excerpt)

```json
{
  "version": 1,
  "personas": [
    { "id": "retail", "name": "Retail customer", "goals": ["Know if I'm fine this month", "Pay bills fast"] }
  ],
  "screens": [
    { "id": "home", "name": "Home", "route": "/home", "path": "web/src/routes/home.tsx", "node": "web", "source": "scan" },
    { "id": "transfer-new", "name": "New transfer", "route": "/transfer/new", "path": "web/src/routes/transfer/new.tsx", "node": "web", "source": "scan" },
    { "id": "transfer-done", "name": "Transfer sent", "route": "/transfer/:id/done", "path": "web/src/routes/transfer/done.tsx", "node": "web", "source": "scan" }
  ],
  "journeys": [
    {
      "id": "pay-rent",
      "name": "Pay rent",
      "persona": "retail",
      "goal": "Pay my rent before the 1st",
      "priority": "core",
      "why": "Paying a known person is the most frequent money-moving action. It must feel faster than the banking habit people bring from their old bank.",
      "signal": "Median time from app open to transfer sent < 30 s",
      "steps": [
        {
          "id": "check-balance",
          "screen": "home",
          "action": "Opens the app and reads the balance",
          "sees": "Available balance, then the last 3 transactions",
          "why": "Checking the balance is the #1 reason people open a bank app, so it is the first thing on screen, above everything else.",
          "touches": ["web/src/routes/home.tsx#BalanceCard", "api/src/routes/accounts.ts#GET /accounts/:id/balance", "ledger-db"],
          "evidence": [{ "quote": "I only open it to see if my salary landed.", "source": "Interview — customer 4", "date": "2026-09-10" }]
        },
        {
          "id": "start-transfer",
          "screen": "home",
          "action": "Taps Transfer, right below the balance",
          "why": "Transfer is the most common next action after checking the balance; one tap, no menu.",
          "touches": ["web/src/routes/home.tsx#QuickActions"],
          "signal": "≥ 70 % of transfers start from this button"
        },
        {
          "id": "fill-and-send",
          "screen": "transfer-new",
          "action": "Picks the landlord from recent payees, confirms the amount, sends",
          "why": "Rent goes to the same person every month: recent payees first, amount prefilled from last time.",
          "touches": ["web/src/routes/transfer/new.tsx#TransferForm", "api/src/routes/transfers.ts#POST /transfers", "payments", "ledger-db"],
          "question": "Should transfers under €50 skip the PIN?",
          "origin": "agent"
        }
      ],
      "branches": [{ "from": "fill-and-send", "when": "Insufficient funds", "journey": "insufficient-funds" }]
    }
  ]
}
```

## 3. Screens from code

### 3.1 Detector (`src/scan/detectors/screens.ts`)

Runs in `ruah app scan` for every package the entrypoints detector classifies as `frontend`. Regex / file-convention based like the rest of the scanner, no new dependencies.

| Framework | Source of screens | Notes |
| --- | --- | --- |
| Next.js app router | `app/**/page.{tsx,jsx,ts,js,mdx}` | route from folders; `(group)` dropped, `[id]` → `:id`, `@slot` skipped |
| Next.js pages router | `pages/**/*.{tsx,jsx,ts,js}` | skip `_app`, `_document`, `api/**` |
| TanStack Router / Start | `routeTree.gen.ts` when present, else `src/routes/**` file routes | `$id` → `:id`, `_layout` / `__root` skipped |
| React Router / Remix | `createBrowserRouter([...])`, `<Route path=…>`, `app/routes/*` (Remix flat routes) | nested paths joined |
| Expo Router | `app/**/*.tsx` | `(tabs)` dropped; `_layout` skipped |
| SvelteKit | `src/routes/**/+page.svelte` | `[id]` → `:id` |
| Nuxt | `pages/**/*.vue` | |
| Others (Angular, Vue Router, plain SPA) | none in phase 2 | screens are added by hand or by the agent |

A screen's `name` comes from the route (`/transfer/new` → "Transfer / new"), the default export name or a `<title>` / `export const metadata = { title }` when found. `node` is the frontend map element that owns the file.

### 3.2 Merge rules (same spirit as workflows `source: "scan"` and §1.7 provenance)

- `source: "scan"` screens are replaced on every scan.
- A scanned screen a journey still references that disappears from the code stays in the file with a warning ("screen `/cards` no longer found in `web`") instead of breaking the journey.
- `user` / `agent` screens are never touched by a scan.
- `product.json` is created by the first scan that finds screens, with empty `personas` / `journeys`. The scan never writes journeys.

As built (CONTRACTS.md §23.4): a router entry with children is a layout, not a screen (its index child is); React Router `*` catch-alls and `<Navigate>` redirects are skipped; ids keep route params (`/transfer/:id/done` → `transfer-id-done`), and a rescan keeps the id (and `shot`) of the screen at the same node + route; an invalid `product.json` is never overwritten by a scan.

## 4. Agents

### 4.1 Tools (MCP server `ruah`, same transports and token rules as §1.7)

| Tool | Arguments | Effect |
| --- | --- | --- |
| `ruah_get_product` | `journey?` | text summary: personas, screens (`id · route · path`), journeys with their steps (`n. screen · action · touches`), open questions, warnings |
| `ruah_get_journey` | `id` | JSON: the journey, its branches, every touch resolved (`id · name · type · path`) or marked broken |
| `ruah_journeys_for` | `element` | journeys and steps that touch a map element (or anything inside it) |
| `ruah_product_apply` | `ops: ProductOp[]` (≤ 200) | all or nothing, one save, one broadcast |

```ts
type ProductOp =
  | { op: "add_persona"; id?; name; description?; goals? } | { op: "update_persona"; id; patch } | { op: "remove_persona"; id }
  | { op: "add_screen"; id?; name; route?; path?; node? } | { op: "update_screen"; id; patch } | { op: "remove_screen"; id }
  | { op: "add_journey"; id?; name; persona?; goal; why?; priority?; signal?; steps: StepInput[] }
  | { op: "update_journey"; id; patch }                       // name, persona, goal, why, priority, signal, reviewedAt
  | { op: "remove_journey"; id }
  | { op: "add_step"; journey; after?; step: StepInput }      // after = step id; absent = append
  | { op: "update_step"; journey; id; patch }
  | { op: "remove_step"; journey; id }
  | { op: "move_step"; journey; id; after: string | null }
  | { op: "add_evidence"; journey; step; evidence: Evidence }
  | { op: "add_branch"; journey; branch: Branch } | { op: "remove_branch"; journey; from; when };
```

Everything an agent writes carries `origin: "agent"` and shows the lavender dot until **Keep** (§1.7). `arch.undo` for a turn also undoes that turn's product ops (one snapshot per turn covers both files).

### 4.2 Instruction line (added to the §1.7 sentence)

> You can read and edit this project's customer journeys with `ruah_get_product` and `ruah_product_apply`. When you change a screen or the code behind a journey step, keep its `touches` in sync. Do not invent a step's `why` or `evidence`: when the reason is not written in the code, the docs or this conversation, leave `why` empty and put your question in `question`.

The last sentence matters. An agent can map *what* the code does; the *why* is a product decision, and a made-up rationale is worse than an honest gap.

### 4.3 Context pack additions (§3.1, deterministic)

After `workflows:`, when the selected node (or a file or symbol inside it) is touched by journey steps:

```
journeys:
- {journey.name} ({persona.name}, {priority}): step {i} of {n} "{step.action}"
  why: {step.why | journey.why}
  signal: {step.signal | journey.signal}
  question: {step.question}
```

Rules: journeys in file order, max 6; `why` truncated to 300 chars; `signal`/`question` lines omitted when empty; `priority` omitted when absent. Worst case stays under ~600 extra tokens.

When a prompt is sent **from a journey step** (§5.2), `prompt.journeyStep = { journey, step }` and the pack gets a `[ruah journey]` block instead: the whole journey (every step's screen, action and why, the current step marked `THIS`), then the current step's touches in the §3.1 node format.

## 5. Viewer

### 5.1 Journeys mode

The map's mode toggle becomes **Architecture · Workflows · Journeys**.

- **Sidebar:** journeys grouped by persona, `core` first; a dot for open questions and broken links.
- **Canvas: journey lanes.** Steps left to right. Rows top to bottom:
  - **Customer:** action, `sees`, a one-line why
  - **Screen:** route, thumbnail from §6 when there is one
  - **Frontend:** components, hooks, frontend files
  - **Backend:** route handlers, services, gateways
  - **Data & external:** datastores, queues, externals

  Rows are computed from `touches` by element type (a symbol by its `symbol.kind`), so nobody lays them out by hand. Branches hang below the step they leave from, labelled with their `when`. A branch with `rejoin` curves back into the main line, and a `to` branch is drawn as a loop arrow.
- **Two views, one data model** (toggle in the canvas toolbar):
  - **Line** (default for one journey): the main path left to right, with the lanes above. It answers "what does the customer do, and what runs behind each step?"
  - **Graph** (default when a persona or "All journeys" is selected): the **app flow map**. Screens are nodes and steps are the arrows between them (labelled with the action), for every journey at once. Journeys that share a screen merge there, branches and loops show as real edges, and each journey gets its own colour (hover one to isolate it). It answers "how do people move through the whole app, from the first click through onboarding to the dashboard?" Screens no journey reaches show up as dimmed islands, which is the "unmapped screen" gap made visible. Layout: the scanner's layered placement with the entry screen of each journey on the left; positions dragged by hand are kept per screen.
- **Step inspector:** tabs **Why** (why, signal, evidence, question with an "Answer" field that writes the answer into `why`), **Code** (touches: open, drill to, broken ones in red with "Ask agent to relink"), **Agent**.

### 5.2 Business overlay on the architecture map

- A **Business** toggle on the Architecture canvas. It tints every element by how many journeys touch it (`core` weighs more), and elements no journey touches fade. That shows where the product value sits and which code is only plumbing.
- Selecting a step in Journeys mode lights up its touches on the architecture map (and the edges between them).
- The element inspector gets a **Journeys** section: "Used in Pay rent (step 3), Onboarding (step 5)", each a link.
- **Ask agent** from a step sends `prompt.journeyStep` (§4.3), so a request like "make the transfer faster" arrives with the journey's why and signal.

### 5.3 Authoring

- **New journey** (sidebar `+`): persona, goal, then steps as a list: pick a screen (typeahead over screens), write the action, optional why. Touches are added from the Code tab by searching the map (`ruah_find_elements` semantics) or by pressing **Link selection** while an element is selected on the architecture map.
- **Draft with agent** button: sends "Map the *{goal}* journey for *{persona}*: find the screens, the actions and the code path; leave the why as questions" to the active agent. The result arrives as agent-origin steps to **Keep** or edit.

### 5.4 Gaps and drift ("Product health")

A panel in Journeys mode and a count on the project's Home card, in the same "what needs you" style:

| Gap | Rule |
| --- | --- |
| Broken link | a `touches` entry or `screen.path` that no longer resolves (§2.2 warnings) |
| Drifted journey | a file behind a touch changed in git since `reviewedAt` (or since the journey was added). **Mark reviewed** sets `reviewedAt` |
| Unmapped screen | a scanned screen no journey step uses |
| Missing why | a `core` journey, or a step in one, with no `why` |
| No signal | a `core` journey with no `signal` on the journey or any step |
| No evidence | a `core` journey with no evidence anywhere |
| Weak evidence | a `core` journey whose strongest evidence is `stated_preference` or weaker (strength ≤ 2), or a step with `contradicts` evidence |
| Open question | any step with a `question` |

## 6. Screenshots from the live preview

- While a step is selected and the preview runs, the preview toolbar shows **Capture for "{step.action}"**. It captures the preview area (`webContents.capturePage(rect)` on the viewer for iframes, the `<webview>`'s own `webContents` otherwise), stores a WebP and writes `screen.shot`.
- Storage: `.ruah/shots/<screenId>.webp`, local by default because screenshots can contain real data; **Save to repo** copies it to `product/shots/` and rewrites `shot`. Browser-mode viewer (no Electron): capture is unavailable, upload an image instead.
- Later (not in the first cut): record a walk-through in the preview (route changes + clicks) and draft the steps from it.

## 7. Customer evidence

- **Add evidence from notes**: paste a call transcript or notes into the Journeys composer with "attach to journeys". The agent quotes, never paraphrases, into `add_evidence` ops on the matching steps, and proposes new `question`s where the notes contradict a step's why ("2 of 5 users looked for Transfer in the menu").
- Evidence is text only; no audio or files are stored.

## 8. Sharing

- **Storyboard export**: one self-contained HTML per journey: persona, goal, why, then each step as a card (screenshot, action, why, signal, evidence) with the code path under it, collapsed. Made for people who never open Ruah.
- **draw.io**: a page per journey in the existing exporter (`src/export/drawio.ts`), lanes as swimlanes.
- **Markdown**: a journey as a PR-ready block (`ruah app journeys export pay-rent --md`).
- CLI: `ruah app journeys` lists journeys with gap counts; `ruah app journeys show <id>`.

As built (CONTRACTS.md §23.7): `ruah app journeys [--root <dir>] export <id>|--all --format html|md|drawio` (`--md` / `--html` / `--drawio` as shorthands, `--out -` for stdout), and `GET /api/product/export?format=…&journey=…` for the viewer. `--all` (or no `journey`) puts every journey in one file: the storyboard gets an index grouped by persona. Local screenshots (`.ruah/shots`) are embedded in the storyboard unless `--no-shots` / `shots=0`. The architecture draw.io export (`ruah app export drawio`, the viewer's Export) also carries the journey pages whenever `product.json` has journeys. The lane rule the draw.io pages use lives in `src/product/lanes.ts` (`laneOf`) for the viewer to mirror.

## 9. Phases

Each phase ships on its own and is useful on its own.

| # | Phase | Deliverables | Done when |
| --- | --- | --- | --- |
| J1 | Contract and store | `src/contracts/product.ts` (zod), `src/serve/product-store.ts` (load → validate → watch → revision → broadcast, like `architecture-store.ts`), WS `product` message + `product.save`, viewer `ui/src/lib/contracts.ts` copy, CONTRACTS.md §23 | the §2.3 example round-trips; each rule in §2.2 has a test; an invalid file keeps the last good version |
| J2 | Screens detector | `src/scan/detectors/screens.ts` for Next (app + pages), TanStack, React Router / Remix, Expo; §3.2 merge; fixture `test/fixtures/bank-app` (Vite + React Router + Express + Postgres) | scan of the fixture yields its screens with routes and paths; re-scan keeps referenced screens that vanished, with a warning |
| J3 | Agent tools and context | `ruah_get_product`, `ruah_get_journey`, `ruah_journeys_for`, `ruah_product_apply` in `src/mcp/tools.ts` + `/api/product/ops`; §4.2 line; §4.3 pack lines; undo covers product ops | the mock agent drafts "Pay rent" on the fixture; the pack for `ledger-db` lists the journey; undo removes the draft |
| J4 | Journeys mode | lanes canvas, step inspector, sidebar, authoring (§5.1, §5.3) | "Pay rent" on the fixture reads left to right with the right code in the right rows, in all three themes |
| J5 | Business overlay and gaps | §5.2 overlay + element Journeys section; §5.4 panel + Home count | renaming `TransferForm` in the fixture shows one broken link and one drifted journey |
| J6 | Screenshots, evidence, sharing | §6, §7, §8 | a storyboard of the fixture journey opens in a browser with no Ruah running |

## 9a. As built (2026-09-27)

- **Journeys is its own page** (`/journeys`, `G J`, in the rail under Map) rather than a third mode of the Map's panes: left the journeys / personas / screens, centre Line or Flow map, right the journey or step (or Health). The Map got the Business toggle and the element inspector a Journeys section.
- **Flow map** is its own SVG (journey colours, hover to isolate), laid out by the longest path over the main-line arrows; arrows back to an earlier screen run over the boxes.
- **Ask agent** on a journey or step sets a "Journey · …" chip over the composer; prompts carry `journeyStep` until it is cleared.
- **Customer notes** is a composed prompt: the agent files verbatim quotes with `add_evidence` and turns contradictions into questions; it never writes the why.
- Answering a step's open question moves the answer into its why.

## 10. Decisions (confirmed 2026-09-27)

1. **Separate `product.json`** instead of growing `architecture.json`. Keeps scans and product edits apart, and a product person can own the file.
2. **Repo root, versioned in git**, next to the map, so product decisions are reviewed in PRs with the code.
3. **Screenshots stay local by default** (§6). They can show real balances and names.
4. **Both line and graph.** Stored as a main line of steps plus branches (in-journey jumps, or alternate journeys that can rejoin), so each journey still reads left to right. Shown as a line for one journey and as a graph (the app flow map) across journeys (§5.1).
5. **Name: Journeys.**
