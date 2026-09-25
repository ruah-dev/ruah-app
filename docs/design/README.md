# Ruah design system in the app

`ruah-design-system.html` is a reference copy of the **Ruah Design System v1.0** (Claude Design,
standalone export; the embedded font files are left out). It is the source of truth for colour,
themes, radii, shadows, the component kit and the Phantom. This page explains how the app maps it
onto its own tokens.

## One place: `ui/src/design/tokens.ts`

| Section | What it holds |
| --- | --- |
| 1. `DESIGN_SYSTEM` | The design system's values **verbatim**, with its own names (`teal-400`, `lavender-300`, `surface-2`, `fg-muted`, radii, shadows): the palettes `default`, `dusk`, `sunrise` and the themes `dark`, `light`, `contrast`. |
| 2. `PALETTES` | The app's palettes, composed from design-system scales (below). |
| 3. `THEMES` | The app's surfaces. Dark is the design system's warm charcoal lifted about two steps (`#111110` → page `#20201e`, sidebar `#1a1a19`) — the user asked for "dark, but more visible". Light and high contrast follow the design system's families. |
| 4. `resolveTokens` | Design-system roles → the app's semantic CSS custom properties, per palette × theme. |
| 5. `CONTRAST_PAIRS` | Every text / UI pair the WCAG check runs. |

`ui/src/design/tokens.css` is **generated** from it and imported by `ui/src/styles.css`:

```sh
pnpm design:tokens          # = ruah app design css --out ui/src/design/tokens.css
ruah app design check       # WCAG contrast of every pair, every palette × theme (exit 1 on a failure)
ruah app design tokens --palette dusk --theme light [--json]
ruah app design palettes
```

**A design update is a single edit:** paste the new values into `DESIGN_SYSTEM`, run
`pnpm design:tokens`, then `pnpm test`. The test suite fails while `tokens.css` is stale or when a
pair drops below its minimum.

## Palettes

Stored in `localStorage["ruah.palette"]`; `<html data-palette>` carries it (absent = default).

| id | Name | brand (primary, interactive) | ai (agents; the secondary) | ok | warn | bad | info | Extras (map kinds, charts, providers) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `teal` *(default)* | **Teal + Indigo** | default `teal` `#00d2b9` | dusk `teal` = **indigo** `#6578ff` | default sage | default amber | default coral | default slate | azure (teal × indigo), rose, lavender |
| `dusk` | **Indigo** | dusk indigo `#6578ff` | dusk dusty rose `#d983b0` | dusk sage-lime | dusk amber | dusk soft coral | dusk slate | teal, azure, lavender |
| `sunrise` | Sunrise | sunrise coral `#ff6b47` | sunrise orange `#ffa94d` | sunrise teal | sunrise yellow | sunrise raspberry | sunrise taupe | indigo, rose, lavender |
| `classic` | Classic teal | default teal | default lavender `#b594f5` | default sage | default amber | default coral | default slate | azure, rose, indigo |

- The design system's **dusk** is indigo, so the id `dusk` now means **Indigo** (the old app
  "Dusk" was a lavender accent swap). Keeping the id means the first-paint boot script already
  applies it.
- `classic` is the design system's default palette unchanged (the look before Teal + Indigo).
  **Wiring:** `THEME_BOOT` in `routes/__root.tsx` only accepts `dusk` and `sunrise`; it must accept
  every id in `PALETTE_BOOT_IDS` (`dusk`, `sunrise`, `classic`) or a stored `classic` shows the
  default palette for one frame after a reload.

## Themes

`dark` (default, lifted) · `light` · `contrast` (pure black / white, text held to **7:1**), plus
`system` in Settings. Surfaces: `surface-0` (sidebar) < `background` (page) < `surface-1` / `card`
< `surface-2` < `surface-3` < `surface-4`; `hairline` / `border`; `foreground`,
`muted-foreground`, `faint` (the design system's `fg`, `fg-muted`, `fg-subtle`).

## Mapping

Fill step per theme: **400** in dark (the design system's base), **500** in light, **300** in high
contrast.

| App token | From | Rule |
| --- | --- | --- |
| `--primary`, `--ring`, `--sidebar-primary` | brand, 500 (300 in contrast) | text-safe on every surface and on its own 15 % tint; the theme ink (`--primary-foreground`: `#111110` dark, `#fff` light, `#000` contrast) ≥ 4.5:1 on it |
| `--brand` | brand fill | text-safe (gradient text, accents) |
| `--ai`, `--ai-foreground` | ai fill | as primary — agent chips, "current" pills, AI glow on the map |
| `--ok` `--warn` `--bad` `--info` | sage / amber / coral / slate | text-safe; `Pill` puts them on a 12–15 % tint of themselves |
| `--destructive` | bad fill | as primary (ink on it) |
| `--node-service` / `-frontend` / `-data` / `-queue` / `-gateway` / `-external` / `-step` / `-file` | brand / ai / extra 1–3 / info / pale ai / warm neutral | text-safe (the code preview uses them as syntax colours); **never a status hue**, so an element never reads as failing by its kind |
| `--cat-1…6` (`--series-1…6`) | brand, ai, extra 1–3, info | ≥ 3:1 — chart series, provider tints (`bg-cat-3/15 text-cat-3`) |
| `--agent-claude` `-cursor` `-grok` `-kiro` `-opencode` | fixed identity hues, lightness per theme | ≥ 3:1 — the agent's ghost, chart series, `AgentMark` fill |
| `--ph-brand` `-ai` `-ok` `-warn` `-bad` `-info` `-brand-soft` `-extra-1…3` | role fills | the Phantom bodies: the design system's exact step whenever it reaches 3:1 on the page |
| `--ph-eye` `-shine` `-paper` `-ink` `-prop` `-prop-deep` `-screen` `-edge` `-muted` `-cream` | theme neutrals | the Phantom's eyes and props |
| `--term-*` | red = bad, green = ok, yellow = warn, blue / magenta / cyan per palette | text-safe on the terminal background (brights too) |
| `--edge-active` | brand fill | ≥ 3:1 on the canvas |

**Readable adjustments.** Accent tokens keep the design system's hue and chroma; where a pair
would fail WCAG, only OKLab lightness moves (`color.ts` `readable`) until it passes. Examples in
dark: `--ai` is indigo `#6578ff` lifted to `#8da1ff` for text (the indigo fills — ghosts, charts —
stay `#6578ff`); `--faint` `#8f8a7e` → `#999488` so hints pass on popovers too. In light the fills
deepen (teal `#00bea8` → `--primary` `#137164`).

**The check** (`ui/test/design-tokens.test.ts`, `ruah app design check`): body text pairs ≥ 4.5:1
(7:1 in the contrast theme) — foreground / muted / faint on every surface, inks on accent fills,
semantic colours on surfaces and on their own tints, node kinds, terminal colours; UI pairs ≥ 3:1 —
focus ring, input borders, map edges, chart / agent / Phantom colours. 199 pairs × 4 palettes × 3
themes, all passing.

## Scopes

- **Page:** `<html data-theme="dark|light|contrast" data-palette="dusk|sunrise|classic">`.
- **Live preview:** any element with `data-ruah-preview="<theme>:<palette>"` renders its subtree in
  that palette × theme (every token is re-declared there). Settings → Appearance and the `/_ghosts`
  sheet use it.

## Components (`ui/src/components/ui/*`)

Following the design system's kit, in the app's type:
- **Button:** `default` (primary fill), `ai`, `soft` (primary tint), `outline`, `ghost`,
  `destructive`; 2 px focus ring in `--ring`.
- **Badge:** `brand` `ai` `ok` `warn` `bad` `info` — pill, the role colour on its tint.
- **Alert:** `info` `ai` `ok` `warn` `bad` — 3 px role-coloured edge on `surface-2`, title and icon
  in the role colour.
- **Input / Textarea:** focus = ring-coloured border + soft 3 px ring.
- **Toasts:** a Phantom with the matching face and a 3 px edge in the role colour.
- Radii keep the app's scale (controls 8 px, cards 12 px — close to the design system's 10 / 16);
  the design system's radii are exposed as `--ds-r-xs…pill`. Shadows keep the app's `--elev-*`,
  tuned for the lifted surfaces.

## Typography

The app keeps the **system UI font** for all chrome and **Geist Mono** for code (the user rejected
the website's DM Sans + Instrument Serif inside the app, 2026-09-23). The design system's serif
display is **not used** (default off): it would need a bundled font for the offline desktop app,
a display serif fights the dense tool UI, and the empty-state headlines are short — the Phantom
carries the personality there. Eyebrows use the design system's rhythm (11 px, 0.14em tracking,
uppercase) in the system font, coloured by role.

## The Phantom family (`ui/src/components/brand`)

Everything is exported from `components/brand/index.ts`; `/_ghosts` shows it all per palette ×
theme (`?palette=dusk&section=poses&size=200&theme=light`).

- **`Phantom`** — 8 expressions: idle (brand), thinking (ai), tracking, agent (ai), success (ok),
  loading (soft mint, as the design system asks), warning (warn), error (bad). `PhantomCompanion`
  follows the pointer.
- **`PhantomPose`** — 19 poses on the design system's `#phantom-body` silhouette, in its flat
  style: `sleeping` (nothing running), `celebrating` (all done), `reading` (scanning), `building`
  (an agent editing files), `searching`, `cloud`, `infra`, `terminal`, `detective` (debugging
  errors), `traveler` (switching projects), `keyholder` (keys, secrets, extensions), `headset`
  (help), `waving` (hello), `charting` (usage — the Accountant), `plugging` (integrations),
  `painting` (appearance), `checklist` (tasks), `chatting` (chats), `mapping` (the map).
- **`PhantomAgent`** — each coding agent's own ghost: its identity tint plus a small generic
  emblem from 32 px (asterisk, pointer, bolt, sparkle, chevrons — never vendor artwork);
  `agentTintOf(id)` / `agentTintFromName(name)` map daemon ids and names.
- **`PhantomScene`** — group scenes: `duo` (you and your agent), `trio` (agents in parallel),
  `handoff`, `party`, `crew` (the five agents).
- **`EmptyState`** — a page state: ghost / pose / scene on a soft tone disc, a role-coloured
  eyebrow, title, body, actions, optional live region.

Rules: SVG + CSS-only motion (transform / opacity), a per-instance phase, static under
`prefers-reduced-motion` and in the high-contrast theme, paused while the tab is hidden; pupils
are the body's own deep shade (never black); decorative unless given a `label`.
