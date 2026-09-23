# Atlas — Linear-inspired precision redesign

## Goal
Refine the existing explorer into a restrained professional workspace: flatter surfaces, tighter rhythm, clearer hierarchy, and less decorative chrome. Preserve every existing diagram, workflow, drill-down, code, repository, and agent interaction.

## Visual direction
- Use the selected graphite and cyan system with Space Grotesk for headings, DM Sans for interface text, and monospace only for paths and code.
- Remove glassmorphism, glow-heavy states, oversized rounded containers, and decorative badges.
- Adopt crisp 4–6px radii, fine dividers, controlled shadows, quieter status colors, and 100–160ms transitions.
- Keep a firm three-column command workspace with a dominant diagram canvas.

## Implementation
1. **Workspace frame and command bar**
   - Tighten the outer frame and top bar.
   - Make repository, mode, search, and panel controls read as one precise command surface.
   - Preserve resizable and collapsible side panels.

2. **Navigation and repository panel**
   - Replace card-like selected views with flat rows and a slim active indicator.
   - Standardize section labels, tree indentation, icon weight, and row heights.

3. **Diagram canvas**
   - Replace the square grid with a subtle drafting dot grid.
   - Restyle groups, nodes, edges, selection, popovers, minimap, breadcrumbs, and zoom controls using low-contrast borders and restrained cyan emphasis.
   - Keep panning, zooming, hover connections, selection, drill-down, and agent prompts unchanged.

4. **Inspector, code, and agent surfaces**
   - Organize details as clean divided sections rather than nested cards.
   - Refine tabs, metadata, health signals, code highlights, and prompt composer.
   - Keep all existing tabs, source previews, canned replies, and contextual actions functional.

5. **Validation**
   - Verify the full desktop workflow: select a node, ask the agent, drill down, open code, switch modes, resize/collapse panels, and use canvas controls.
   - Check the current desktop viewport for clipping, overlap, and visual consistency, then confirm a clean build and runtime.

## Technical details
- Changes stay within existing frontend styling and explorer components.
- Semantic design tokens remain the only source of colors and shadows.
- No backend, data model, graph behavior, or product scope changes.
