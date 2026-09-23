// The map canvas. Built to stay fast and legible from a 5-element level to a 1,000-element
// system (docs/DESIGN-NOTES.md "Map canvas"):
// - Camera outside React: pan/zoom write one CSS transform on the world layer (compositor
//   only, `will-change` just while moving so text re-rasterises crisp when it stops).
// - Viewport culling: big levels render only elements / edges near the viewport; React re-renders
//   only when the view leaves the rendered window or the zoom crosses a level-of-detail step.
// - Level of detail: full cards → compact bar + name → tiny blocks; edge labels on demand.
// - Focus: search (⌘F), kind / layer filters, n-hop neighbourhood, collapsible layer groups,
//   selection emphasis (others stay ≥ 60 %), arrow-key navigation, minimap, fit-to-selection.
// - Drill: chip / double-click / Enter zooms into the element and opens its level; Backspace /
//   ⌥↑ goes back up.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronsDownUp, Maximize2, Minus, MousePointer2, Plus } from "lucide-react";
import type { DiagramNode as NodeType, NodeKind } from "@/data/graphs";
import type { Diagram } from "@/lib/workspace";
import { NODE_H, NODE_W, groupIcon as GroupIcon } from "@/components/explorer/kinds";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  boundsOf,
  clampZoom,
  contains,
  fitCamera,
  grow,
  intersects,
  lodFor,
  nearestInDirection,
  nodeBox,
  viewRect,
  type Box,
  type Camera,
  type Direction,
  type Lod,
} from "./canvas/geometry";
import { routeEdges } from "./canvas/routing";
import { buildViewModel, isGroupNodeId, NO_FILTERS, searchNodes, type CanvasFilters } from "./canvas/view-model";
import { NodeCard, type NodeHandlers, type NodeTone } from "./canvas/NodeCard";
import { EdgeLayer } from "./canvas/EdgeLayer";
import { Minimap, type MinimapHandle } from "./canvas/Minimap";
import { FilterMenu, SearchBar, ToolbarButtons, type SearchHit } from "./canvas/CanvasToolbar";

export type EdgeRef = { from: string; to: string };
export type { SearchHit };

type Props = {
  /** Show the built-in "Empty diagram" hint (the Map shows its own card for empty projects). */
  emptyHint?: boolean;
  diagram: Diagram;
  editable: boolean;
  selectedNodeId: string | null;
  selectedEdge: EdgeRef | null;
  onSelectNode: (id: string | null) => void;
  onSelectEdge: (edge: EdgeRef | null) => void;
  onMoveNode: (id: string, x: number, y: number) => void;
  onAddNode: (kind: NodeKind, x: number, y: number) => void;
  onRenameNode: (id: string, label: string) => void;
  onConnect: (from: string, to: string) => void;
  onDeleteNode: (id: string) => void;
  onDrill: (node: NodeType) => void;
  onOpenCode: (node: NodeType) => void;
  onAsk: (node: NodeType) => void;
  /** Copies the daemon's context pack for the node (GET /api/context/:id). Resolves false on failure. */
  onCopyContext?: (node: NodeType) => Promise<boolean>;
  /** This canvas owns the keyboard (the active pane). Default true. */
  active?: boolean;
  /** Depth of the level (0 = top): picks the zoom-in / zoom-out transition. */
  depth?: number;
  /** Backspace / ⌥↑: the level above. */
  onGoUp?: (() => void) | undefined;
  /** Click on a symbol (file level): show its code. */
  onActivateSymbol?: ((node: NodeType) => void) | undefined;
  /** Elements of other levels, for "Elsewhere in the map" search results. */
  searchIndex?: readonly SearchHit[] | undefined;
  onReveal?: ((id: string) => void) | undefined;
  /** Overlay at the bottom centre (loading / truncated notices). */
  notice?: ReactNode;
};

const GRID = 8;
const snap = (v: number) => Math.round(v / GRID) * GRID;
/** Render everything below this many elements; cull above it. */
const CULL_ABOVE = 160;
// Zoom steps at which `--inv-k` (text / toolbar counter-scaling) is updated: coarse, so a zoom
// gesture restyles the cards a handful of times instead of every frame.
const K_STEP = 1.25;
const quantize = (k: number) => Math.pow(K_STEP, Math.round(Math.log(k) / Math.log(K_STEP)));

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

type ViewState = { lod: Lod; kq: number; cull: Box | null };

export function EditorCanvas({
  diagram,
  editable,
  emptyHint = true,
  selectedNodeId,
  selectedEdge,
  onSelectNode,
  onSelectEdge,
  onMoveNode,
  onAddNode,
  onRenameNode,
  onConnect,
  onDeleteNode,
  onDrill,
  onOpenCode,
  onAsk,
  onCopyContext,
  active = true,
  depth = 0,
  onGoUp,
  onActivateSymbol,
  searchIndex,
  onReveal,
  notice,
}: Props) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const zoomLabelRef = useRef<HTMLSpanElement | null>(null);
  const minimapRef = useRef<MinimapHandle | null>(null);
  const cam = useRef<Camera>({ x: 16, y: 12, k: 0.85 });
  const size = useRef({ w: 0, h: 0 });
  const [view, setView] = useState<ViewState>({ lod: "full", kq: quantize(0.85), cull: null });
  const viewRef = useRef(view);
  viewRef.current = view;

  const [hoverId, setHoverId] = useState<string | null>(null);
  const [hoverEdge, setHoverEdge] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [filters, setFilters] = useState<CanvasFilters>(NO_FILTERS);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchIdx, setMatchIdx] = useState(0);

  const panRef = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  const dragRef = useRef<{ id: string; dx: number; dy: number; sx: number; sy: number; moved: boolean } | null>(null);
  const lastDragMoved = useRef(false);
  const movingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const anim = useRef<number | null>(null);
  const cams = useRef(new Map<string, Camera>());
  const prevLevel = useRef<{ id: string; depth: number } | null>(null);
  const pendingDrill = useRef<{ from: string; cam: Camera; timer: ReturnType<typeof setTimeout> } | null>(null);
  const recullFrame = useRef<number | null>(null);
  const drawFrame = useRef<number | null>(null);
  const lastZoomAt = useRef(0);
  const deferTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // ---- what we draw ---------------------------------------------------------
  const vm = useMemo(
    () => buildViewModel(diagram.nodes, diagram.edges, diagram.groups ?? [], filters, selectedNodeId),
    [diagram.nodes, diagram.edges, diagram.groups, filters, selectedNodeId],
  );
  const boxes = useMemo(() => new Map(vm.nodes.map((n) => [n.id, nodeBox(n)])), [vm.nodes]);
  const routes = useMemo(() => routeEdges(boxes, vm.edges), [boxes, vm.edges]);
  const nodeById = useMemo(() => new Map(vm.nodes.map((n) => [n.id, n])), [vm.nodes]);
  const big = vm.nodes.length > CULL_ABOVE;

  // ---- camera ---------------------------------------------------------------
  const scheduleRecull = useCallback(() => {
    if (recullFrame.current !== null) return;
    recullFrame.current = requestAnimationFrame(() => {
      recullFrame.current = null;
      const c = cam.current;
      const { w, h } = size.current;
      const lod = lodFor(c.k);
      const kq = quantize(c.k);
      const cur = viewRef.current;
      const vr = viewRect(c, w, h);
      const needCull = big && w > 0;
      const stale = needCull ? !cur.cull || !contains(cur.cull, vr) : cur.cull !== null;
      if (lod === cur.lod && kq === cur.kq && !stale) return;
      // Mid-gesture, a detail step alone waits until the wheel pauses: the transform keeps scaling
      // smoothly and the cards are restyled once, not on every step of the gesture.
      if (!stale && performance.now() - lastZoomAt.current < 140) {
        if (deferTimer.current) clearTimeout(deferTimer.current);
        deferTimer.current = setTimeout(() => {
          deferTimer.current = undefined;
          recullRef.current();
        }, 150);
        return;
      }
      if (kq !== cur.kq) worldRef.current?.style.setProperty("--inv-k", String(1 / kq));
      setView({ lod, kq, cull: needCull ? grow(vr, 0.6) : null });
    });
  }, [big]);
  const recullRef = useRef(scheduleRecull);
  recullRef.current = scheduleRecull;

  const scheduleMinimap = useCallback(() => {
    if (drawFrame.current !== null) return;
    drawFrame.current = requestAnimationFrame(() => {
      drawFrame.current = null;
      minimapRef.current?.draw(cam.current, size.current.w, size.current.h);
    });
  }, []);

  const applyCamera = useCallback(
    (next: Camera) => {
      cam.current = next;
      const world = worldRef.current;
      if (world) {
        world.style.transform = `translate3d(${next.x}px, ${next.y}px, 0) scale(${next.k})`;
        // Composite as a bitmap while moving; drop the hint when still so text re-rasterises crisp.
        world.style.willChange = "transform";
        if (movingTimer.current) clearTimeout(movingTimer.current);
        movingTimer.current = setTimeout(() => {
          if (worldRef.current) worldRef.current.style.willChange = "auto";
        }, 180);
      }
      const grid = gridRef.current;
      if (grid) {
        let g = 22 * next.k;
        while (g < 14) g *= 2;
        while (g > 44) g /= 2;
        grid.style.backgroundSize = `${g}px ${g}px`;
        grid.style.backgroundPosition = `${next.x}px ${next.y}px`;
      }
      if (zoomLabelRef.current) zoomLabelRef.current.textContent = `${Math.round(next.k * 100)}%`;
      scheduleRecull();
      scheduleMinimap();
    },
    [scheduleRecull, scheduleMinimap],
  );

  const stopAnim = () => {
    if (anim.current !== null) cancelAnimationFrame(anim.current);
    anim.current = null;
  };

  const animateTo = useCallback(
    (target: Camera, ms = 240) => {
      stopAnim();
      if (ms <= 0 || prefersReducedMotion()) {
        applyCamera(target);
        return;
      }
      const from = { ...cam.current };
      const t0 = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - t0) / ms);
        const e = 1 - Math.pow(1 - t, 3);
        const k = Math.exp(Math.log(from.k) + (Math.log(target.k) - Math.log(from.k)) * e);
        // Keep the eased zoom and pan consistent: interpolate the world point at the viewport centre.
        const { w, h } = size.current;
        const c0 = { x: (w / 2 - from.x) / from.k, y: (h / 2 - from.y) / from.k };
        const c1 = { x: (w / 2 - target.x) / target.k, y: (h / 2 - target.y) / target.k };
        const cx = c0.x + (c1.x - c0.x) * e;
        const cy = c0.y + (c1.y - c0.y) * e;
        applyCamera({ k, x: w / 2 - cx * k, y: h / 2 - cy * k });
        anim.current = t < 1 ? requestAnimationFrame(step) : null;
      };
      anim.current = requestAnimationFrame(step);
    },
    [applyCamera],
  );

  const fitBox = useCallback(
    (b: Box | null, opts: { animate?: boolean; maxK?: number } = {}) => {
      const { w, h } = size.current;
      if (!b || w === 0) return;
      const target = fitCamera(b, w, h, { pad: 56, maxK: opts.maxK ?? 1 });
      if (opts.animate) animateTo(target);
      else applyCamera(target);
    },
    [animateTo, applyCamera],
  );

  const allBounds = useCallback(() => {
    const bs = [...boxes.values(), ...vm.groups.map((g) => ({ x: g.x, y: g.y - 14, w: g.w, h: g.h + 14 }))];
    return boundsOf(bs);
  }, [boxes, vm.groups]);

  const fitAll = useCallback((animate = false) => fitBox(allBounds(), { animate }), [fitBox, allBounds]);

  const fitSelection = useCallback(() => {
    const id = selectedNodeId && boxes.has(selectedNodeId) ? selectedNodeId : null;
    if (!id) {
      fitAll(true);
      return;
    }
    // The selection and its direct links.
    const ids = new Set([id]);
    for (const e of vm.edges) {
      if (e.from === id) ids.add(e.to);
      if (e.to === id) ids.add(e.from);
    }
    fitBox(boundsOf([...ids].map((x) => boxes.get(x)!).filter(Boolean)), { animate: true, maxK: 1.2 });
  }, [selectedNodeId, boxes, vm.edges, fitBox, fitAll]);

  const centerOn = useCallback(
    (id: string, minK = 0.7) => {
      const b = boxes.get(id);
      const { w, h } = size.current;
      if (!b || w === 0) return;
      const k = Math.max(cam.current.k, minK);
      animateTo({ k, x: w / 2 - (b.x + b.w / 2) * k, y: h / 2 - (b.y + b.h / 2) * k });
    },
    [boxes, animateTo],
  );

  const ensureVisible = useCallback(
    (id: string) => {
      const b = boxes.get(id);
      const { w, h } = size.current;
      if (!b || w === 0) return;
      const vr = grow(viewRect(cam.current, w, h), -0.06);
      if (!contains(vr, b)) centerOn(id, 0);
    },
    [boxes, centerOn],
  );

  // Viewport size.
  useLayoutEffect(() => {
    const el = shellRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      size.current = { w: r.width, h: r.height };
      scheduleRecull();
      scheduleMinimap();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scheduleRecull, scheduleMinimap]);

  // Culling depends on the level size.
  useEffect(() => {
    scheduleRecull();
  }, [big, scheduleRecull]);

  // A level opened: restore its camera or fit it, with a short zoom transition.
  const fitRef = useRef(fitAll);
  fitRef.current = fitAll;
  const hasNodes = diagram.nodes.length > 0;
  useLayoutEffect(() => {
    const prev = prevLevel.current;
    if (prev && prev.id !== diagram.id) cams.current.set(prev.id, { ...cam.current });
    const dir = !prev || prev.id === diagram.id ? "none" : depth > prev.depth ? "in" : depth < prev.depth ? "out" : "none";
    prevLevel.current = { id: diagram.id, depth };
    if (pendingDrill.current) {
      clearTimeout(pendingDrill.current.timer);
      pendingDrill.current = null;
    }
    setEditingId(null);
    setLinkFrom(null);
    setHoverId(null);
    setHoverEdge(null);
    setMatchIdx(0);
    stopAnim();
    const saved = cams.current.get(diagram.id);
    if (saved && dir !== "in") applyCamera(saved);
    else fitRef.current(false);
    const stage = stageRef.current;
    if (stage && dir !== "none" && !prefersReducedMotion() && typeof stage.animate === "function") {
      stage.animate(
        [
          { transform: dir === "in" ? "scale(0.94)" : "scale(1.06)", opacity: 0.25 },
          { transform: "scale(1)", opacity: 1 },
        ],
        { duration: 200, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagram.id, hasNodes]);

  // Filters are per level.
  useEffect(() => {
    setFilters(NO_FILTERS);
  }, [diagram.id]);

  // ---- input: wheel (pan / zoom), background drag, node drag ----------------
  const toWorld = useCallback((clientX: number, clientY: number) => {
    const rect = shellRef.current?.getBoundingClientRect();
    const c = cam.current;
    return { x: (clientX - (rect?.left ?? 0) - c.x) / c.k, y: (clientY - (rect?.top ?? 0) - c.y) / c.k };
  }, []);

  const zoomAt = useCallback(
    (clientX: number, clientY: number, factor: number) => {
      stopAnim();
      const rect = shellRef.current?.getBoundingClientRect();
      const sx = clientX - (rect?.left ?? 0);
      const sy = clientY - (rect?.top ?? 0);
      const c = cam.current;
      const k = clampZoom(c.k * factor);
      lastZoomAt.current = performance.now();
      const wx = (sx - c.x) / c.k;
      const wy = (sy - c.y) / c.k;
      applyCamera({ k, x: sx - wx * k, y: sy - wy * k });
    },
    [applyCamera],
  );

  useEffect(() => {
    const el = shellRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest("[data-scrollable]")) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? size.current.h : 1;
      if (e.ctrlKey || e.metaKey) {
        zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * unit * 0.0022));
      } else {
        stopAnim();
        const c = cam.current;
        const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY;
        applyCamera({ ...c, x: c.x - dx * unit, y: c.y - dy * unit });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt, applyCamera]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if ((e.target as HTMLElement).closest("[data-node],[data-ui]")) return;
      stopAnim();
      onSelectNode(null);
      onSelectEdge(null);
      setLinkFrom(null);
      panRef.current = { x: e.clientX, y: e.clientY, cx: cam.current.x, cy: cam.current.y };
    },
    [onSelectNode, onSelectEdge],
  );

  const latest = useRef({ onMoveNode, onConnect, onSelectNode, onSelectEdge, editable, linkFrom, editingId, toWorld });
  latest.current = { onMoveNode, onConnect, onSelectNode, onSelectEdge, editable, linkFrom, editingId, toWorld };

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (panRef.current) {
        const d = panRef.current;
        applyCamera({ ...cam.current, x: d.cx + (e.clientX - d.x), y: d.cy + (e.clientY - d.y) });
        return;
      }
      const drag = dragRef.current;
      if (drag) {
        // A click is not a move: ignore jitter below 4 px so selecting never rewrites positions.
        if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 4) return;
        drag.moved = true;
        const p = latest.current.toWorld(e.clientX, e.clientY);
        latest.current.onMoveNode(drag.id, snap(p.x - drag.dx), snap(p.y - drag.dy));
      }
    };
    const up = () => {
      panRef.current = null;
      lastDragMoved.current = dragRef.current?.moved ?? false;
      dragRef.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [applyCamera]);

  // ---- drill with a zoom-in transition ----------------------------------------
  const drillAnimated = useCallback(
    (node: NodeType) => {
      if (!node.drill) return;
      const b = boxes.get(node.id);
      const { w, h } = size.current;
      if (!b || w === 0 || prefersReducedMotion()) {
        onDrill(node);
        return;
      }
      const before = { ...cam.current };
      const k = clampZoom(Math.max(before.k * 2.4, 1.4));
      animateTo({ k, x: w / 2 - (b.x + b.w / 2) * k, y: h / 2 - (b.y + b.h / 2) * k }, 170);
      stageRef.current?.animate?.([{ opacity: 1 }, { opacity: 0.2 }], { duration: 170, easing: "ease-in" });
      const from = diagram.id;
      setTimeout(() => {
        onDrill(node);
        // The level may still be loading (on-demand expansion): come back if nothing opened.
        const timer = setTimeout(() => {
          if (prevLevel.current?.id === from) animateTo(before, 200);
          pendingDrill.current = null;
        }, 900);
        pendingDrill.current = { from, cam: before, timer };
      }, 150);
    },
    [boxes, onDrill, animateTo, diagram.id],
  );

  const toggleGroup = useCallback((layer: string) => {
    setFilters((f) => {
      const collapsed = new Set(f.collapsedLayers);
      if (collapsed.has(layer)) collapsed.delete(layer);
      else collapsed.add(layer);
      return { ...f, collapsedLayers: collapsed };
    });
  }, []);

  // ---- node handlers (one stable object so memoised cards do not re-render) ---
  const act = useRef({ drillAnimated, onOpenCode, onAsk, onDeleteNode, onRenameNode, onActivateSymbol, toggleGroup, onCopyContext });
  act.current = { drillAnimated, onOpenCode, onAsk, onDeleteNode, onRenameNode, onActivateSymbol, toggleGroup, onCopyContext };
  const handlers = useMemo<NodeHandlers>(
    () => ({
      pointerDown: (e, node) => {
        e.stopPropagation();
        stopAnim();
        const L = latest.current;
        L.onSelectNode(isGroupNodeId(node.id) ? null : node.id);
        L.onSelectEdge(null);
        if (L.linkFrom && L.linkFrom !== node.id && !isGroupNodeId(node.id)) {
          L.onConnect(L.linkFrom, node.id);
          setLinkFrom(null);
          return;
        }
        if (L.editable && L.editingId !== node.id && !isGroupNodeId(node.id)) {
          const p = L.toWorld(e.clientX, e.clientY);
          dragRef.current = { id: node.id, dx: p.x - node.x, dy: p.y - node.y, sx: e.clientX, sy: e.clientY, moved: false };
        }
      },
      click: (_e, node) => {
        if (lastDragMoved.current) return;
        if (node.symbol) act.current.onActivateSymbol?.(node);
      },
      doubleClick: (e, node) => {
        e.stopPropagation();
        dragRef.current = null;
        if (isGroupNodeId(node.id)) {
          if (node.layer) act.current.toggleGroup(node.layer);
          return;
        }
        if (latest.current.editable && !node.ephemeral) setEditingId(node.id);
        else if (node.drill) act.current.drillAnimated(node);
        else if (node.symbol) act.current.onOpenCode(node);
      },
      hover: (id) => setHoverId(id),
      drill: (node) => act.current.drillAnimated(node),
      openCode: (node) => act.current.onOpenCode(node),
      ask: (node) => act.current.onAsk(node),
      copyContext: (node) => act.current.onCopyContext?.(node) ?? Promise.resolve(false),
      toggleLink: (id) => setLinkFrom((v) => (v === id ? null : id)),
      startLink: (id) => setLinkFrom(id),
      remove: (id) => act.current.onDeleteNode(id),
      rename: (id, label) => {
        act.current.onRenameNode(id, label);
        setEditingId(null);
      },
      cancelRename: () => setEditingId(null),
      toggleGroup: (layer) => act.current.toggleGroup(layer),
    }),
    [],
  );

  // ---- search ------------------------------------------------------------------
  const matches = useMemo(() => (searchOpen ? searchNodes(vm.nodes, query) : []), [searchOpen, vm.nodes, query]);
  const matchSet = useMemo(() => new Set(matches), [matches]);
  const currentMatch = matches.length ? matches[Math.min(matchIdx, matches.length - 1)]! : null;
  useEffect(() => {
    setMatchIdx(0);
  }, [query]);
  useEffect(() => {
    if (currentMatch) centerOn(currentMatch, 0.6);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMatch]);
  const elsewhere = useMemo<SearchHit[]>(() => {
    const q = query.trim().toLowerCase();
    if (!searchOpen || !q || !searchIndex) return [];
    const here = new Set(diagram.nodes.map((n) => n.id));
    const out: SearchHit[] = [];
    for (const h of searchIndex) {
      if (here.has(h.id)) continue;
      if (h.label.toLowerCase().includes(q) || h.where.toLowerCase().includes(q)) out.push(h);
      if (out.length >= 6) break;
    }
    return out;
  }, [searchOpen, query, searchIndex, diagram.nodes]);
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery("");
  }, []);

  // ---- keyboard ------------------------------------------------------------------
  const keys = useRef({
    selectedNodeId,
    nodes: vm.nodes,
    editable,
    searchOpen,
    linkFrom,
    onGoUp,
    onDeleteNode,
    onAddNode,
    mode: diagram.mode,
  });
  keys.current = { selectedNodeId, nodes: vm.nodes, editable, searchOpen, linkFrom, onGoUp, onDeleteNode, onAddNode, mode: diagram.mode };
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const K = keys.current;
      const target = e.target as HTMLElement | null;
      const typing = !!target && (/input|textarea|select/i.test(target.tagName) || target.isContentEditable);
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (typing || mod) return;
      // Only when the map is on screen (the canvas may be mounted behind another page).
      if (!shellRef.current?.isConnected || shellRef.current.offsetParent === null) return;
      const sel = K.selectedNodeId && K.nodes.some((n) => n.id === K.selectedNodeId) ? K.selectedNodeId : null;
      if (e.key === "Escape") {
        if (K.searchOpen) closeSearch();
        else if (K.linkFrom) setLinkFrom(null);
        else onSelectNode(null);
        return;
      }
      if (e.altKey && e.key === "ArrowUp") {
        e.preventDefault();
        K.onGoUp?.();
        return;
      }
      if (e.altKey && e.key === "ArrowDown") {
        e.preventDefault();
        const n = sel ? nodeById.get(sel) : undefined;
        if (n?.drill) drillAnimated(n);
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (K.editable && sel && !isGroupNodeId(sel)) {
          e.preventDefault();
          K.onDeleteNode(sel);
        } else if (e.key === "Backspace" && K.onGoUp) {
          e.preventDefault();
          K.onGoUp();
        }
        return;
      }
      if (e.key.startsWith("Arrow") && !e.altKey) {
        e.preventDefault();
        const dir = e.key.slice(5).toLowerCase() as Direction;
        let next: string | null = null;
        if (sel) next = nearestInDirection(K.nodes, sel, dir);
        else {
          // Nothing selected: start from the element nearest the viewport centre.
          const { w, h } = size.current;
          const c = cam.current;
          const cx = (w / 2 - c.x) / c.k;
          const cy = (h / 2 - c.y) / c.k;
          let best = Infinity;
          for (const n of K.nodes) {
            const d = Math.hypot(n.x + NODE_W / 2 - cx, n.y + NODE_H / 2 - cy);
            if (d < best) {
              best = d;
              next = n.id;
            }
          }
        }
        if (next && !isGroupNodeId(next)) {
          onSelectNode(next);
          onSelectEdge(null);
          ensureVisible(next);
        }
        return;
      }
      if (e.key === "Enter" && sel) {
        const n = nodeById.get(sel);
        if (!n) return;
        e.preventDefault();
        if (n.drill) drillAnimated(n);
        else if (n.symbol) onOpenCode(n);
        return;
      }
      if (e.key === "f" && !e.altKey) {
        e.preventDefault();
        fitSelection();
        return;
      }
      if (e.key === "F" && e.shiftKey) {
        e.preventDefault();
        fitAll(true);
        return;
      }
      if ((e.key === "=" || e.key === "+") && !e.altKey) {
        const { w, h } = size.current;
        const r = shellRef.current?.getBoundingClientRect();
        zoomAt((r?.left ?? 0) + w / 2, (r?.top ?? 0) + h / 2, 1.25);
        return;
      }
      if (e.key === "-" && !e.altKey) {
        const { w, h } = size.current;
        const r = shellRef.current?.getBoundingClientRect();
        zoomAt((r?.left ?? 0) + w / 2, (r?.top ?? 0) + h / 2, 0.8);
        return;
      }
      if (K.editable && e.key.toLowerCase() === "n" && !e.altKey) {
        e.preventDefault();
        const kind: NodeKind = K.mode === "workflow" ? "step" : "service";
        const c = cam.current;
        const { w, h } = size.current;
        K.onAddNode(kind, snap((w / 2 - c.x) / c.k - NODE_W / 2), snap((h / 2 - c.y) / c.k - NODE_H / 2));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, nodeById, drillAnimated, ensureVisible, fitSelection, fitAll, zoomAt, onSelectNode, onSelectEdge, onOpenCode, closeSearch]);

  // ---- render ------------------------------------------------------------------
  const cull = view.cull;
  const visibleNodes = useMemo(
    () => (cull ? vm.nodes.filter((n) => n.id === selectedNodeId || intersects(cull, boxes.get(n.id)!)) : vm.nodes),
    [cull, vm.nodes, boxes, selectedNodeId],
  );
  const visibleGroups = useMemo(() => (cull ? vm.groups.filter((g) => intersects(cull, g)) : vm.groups), [cull, vm.groups]);

  // Hover emphasis re-renders cards; on big levels only the selection drives dimming.
  const focusId = (vm.nodes.length <= 300 ? hoverId : null) ?? selectedNodeId;
  const connected = useMemo(() => {
    if (!focusId || !nodeById.has(focusId)) return null;
    const set = new Set<string>([focusId]);
    for (const e of vm.edges) {
      if (e.from === focusId) set.add(e.to);
      if (e.to === focusId) set.add(e.from);
    }
    return set;
  }, [focusId, vm.edges, nodeById]);
  const searching = searchOpen && query.trim() !== "";
  const toneOf = (id: string): NodeTone => {
    if (searching && matchSet.size) return id === currentMatch ? "current" : matchSet.has(id) ? "match" : "dimmed";
    if (connected && !connected.has(id)) return "dimmed";
    return "normal";
  };

  const linkSource = linkFrom ? nodeById.get(linkFrom) : undefined;
  const selectedNode = selectedNodeId ? nodeById.get(selectedNodeId) : undefined;
  const edgeFocus = hoverId ?? selectedNodeId;

  return (
    <div
      ref={shellRef}
      className="relative min-h-0 flex-1 touch-none overflow-hidden select-none"
      onPointerDown={onPointerDown}
      onPointerMove={(e) => {
        if (linkFrom) setCursor(toWorld(e.clientX, e.clientY));
      }}
      onDoubleClick={(e) => {
        if (!editable) return;
        if ((e.target as HTMLElement).closest("[data-node],[data-ui]")) return;
        const p = toWorld(e.clientX, e.clientY);
        onAddNode(diagram.mode === "workflow" ? "step" : "service", snap(p.x), snap(p.y));
      }}
      onDragOver={(e) => {
        if (!editable) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(e) => {
        if (!editable) return;
        const kind = e.dataTransfer.getData("application/ruah-kind") as NodeKind;
        if (!kind) return;
        e.preventDefault();
        const p = toWorld(e.clientX, e.clientY);
        onAddNode(kind, snap(p.x - NODE_W / 2), snap(p.y - NODE_H / 2));
      }}
    >
      <div ref={gridRef} className="grid-canvas absolute inset-0" />

      <div ref={stageRef} className="absolute inset-0 origin-center">
        <div
          ref={worldRef}
          data-lod={view.lod}
          className="absolute top-0 left-0 origin-top-left"
          style={{ transform: `translate3d(${cam.current.x}px, ${cam.current.y}px, 0) scale(${cam.current.k})`, ["--inv-k" as string]: 1 / view.kq }}
        >
          {visibleGroups.map((g) => {
            const layer = g.id.replace(/^layer:/, "");
            return (
              <div
                key={g.id}
                className="group/frame absolute rounded-2xl border border-dashed border-group/35 bg-group/[0.03]"
                style={{ left: g.x, top: g.y, width: g.w, height: g.h }}
              >
                <span
                  className="absolute bottom-[calc(100%-0.6em)] left-3 flex origin-bottom-left items-center gap-1.5 rounded-md bg-canvas px-1.5 font-medium tracking-wide whitespace-nowrap text-group uppercase"
                  style={{ fontSize: "max(11px, min(96px, calc(11px * var(--inv-k, 1))))" }}
                >
                  <GroupIcon className="size-[1em]" />
                  {g.label}
                  <button
                    type="button"
                    data-ui
                    title="Collapse into one card"
                    aria-label={`Collapse ${g.label}`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => toggleGroup(layer)}
                    className="grid size-[1.3em] place-items-center rounded text-group/70 opacity-0 transition-opacity group-hover/frame:opacity-100 hover:bg-group/15 hover:text-group"
                  >
                    <ChevronsDownUp className="size-[0.95em]" />
                  </button>
                </span>
              </div>
            );
          })}

          <EdgeLayer
            edges={vm.edges}
            routes={routes}
            cull={cull}
            lod={view.lod}
            labels={view.kq >= 0.9 ? "all" : view.kq >= 0.45 ? "focus" : "none"}
            focusId={edgeFocus}
            selectedEdge={selectedEdge}
            hoverEdge={hoverEdge}
            onHoverEdge={setHoverEdge}
            onSelectEdge={(edge) => {
              onSelectEdge(edge);
              onSelectNode(null);
            }}
          />
          {linkSource && cursor ? (
            <svg className="pointer-events-none absolute top-0 left-0 overflow-visible" width={1} height={1}>
              <line
                x1={linkSource.x + (linkSource.w ?? NODE_W)}
                y1={linkSource.y + (linkSource.h ?? NODE_H) / 2}
                x2={cursor.x}
                y2={cursor.y}
                stroke="var(--edge-active)"
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
                strokeDasharray="4 3"
              />
            </svg>
          ) : null}

          {visibleNodes.map((node) => (
            <NodeCard
              key={node.id}
              node={node}
              lod={view.lod}
              selected={selectedNodeId === node.id}
              tone={toneOf(node.id)}
              editable={editable && !node.ephemeral}
              renaming={editingId === node.id}
              linking={linkFrom === node.id}
              h={handlers}
            />
          ))}
        </div>
      </div>

      {diagram.nodes.length === 0 && emptyHint && !notice ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="text-center">
            <p className="heading text-[16px] text-foreground">Empty diagram</p>
            <p className="mt-1 text-[12.5px] text-muted-foreground">
              {editable ? "Drag an element from the tray, double-click the canvas, or press N." : "Switch to Edit to add elements."}
            </p>
          </div>
        </div>
      ) : null}

      <div data-ui>
        <ToolbarButtons
          onSearch={() => setSearchOpen(true)}
          onFit={fitSelection}
          hasSelection={!!selectedNode}
          filterMenu={<FilterMenu nodes={diagram.nodes} filters={filters} onChange={setFilters} hasSelection={!!selectedNode} />}
        />
        {vm.hidden > 0 ? (
          <button
            type="button"
            onClick={() => setFilters(NO_FILTERS)}
            className="control-glass absolute top-13 right-3 z-20 rounded-md px-2 py-1 text-[11.5px] text-muted-foreground hover:text-foreground"
          >
            {vm.hidden} hidden by filters · show all
          </button>
        ) : null}
        {searchOpen ? (
          <SearchBar
            query={query}
            onQuery={setQuery}
            count={matches.length}
            index={Math.min(matchIdx, Math.max(0, matches.length - 1))}
            onStep={(d) => setMatchIdx((i) => (matches.length ? (i + d + matches.length) % matches.length : 0))}
            onClose={closeSearch}
            elsewhere={elsewhere}
            onReveal={(id) => {
              closeSearch();
              onReveal?.(id);
            }}
          />
        ) : null}
        <Minimap
          ref={minimapRef}
          nodes={vm.nodes}
          selectedId={selectedNodeId}
          matches={searching ? matchSet : EMPTY}
          onJump={(x, y) => {
            const { w, h } = size.current;
            const k = cam.current.k;
            applyCamera({ k, x: w / 2 - x * k, y: h / 2 - y * k });
          }}
        />
        <div className="control-glass absolute right-3 bottom-3 z-20 flex items-center gap-0.5 rounded-lg p-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="Zoom out"
            onClick={() => {
              const r = shellRef.current?.getBoundingClientRect();
              zoomAt((r?.left ?? 0) + size.current.w / 2, (r?.top ?? 0) + size.current.h / 2, 0.8);
            }}
          >
            <Minus className="size-3.5" />
          </Button>
          <span ref={zoomLabelRef} className="w-10 text-center text-[11px] text-muted-foreground tabular-nums">
            {Math.round(cam.current.k * 100)}%
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="Zoom in"
            onClick={() => {
              const r = shellRef.current?.getBoundingClientRect();
              zoomAt((r?.left ?? 0) + size.current.w / 2, (r?.top ?? 0) + size.current.h / 2, 1.25);
            }}
          >
            <Plus className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="size-6" aria-label="Fit to view" title="Fit to view (⇧F)" onClick={() => fitAll(true)}>
            <Maximize2 className="size-3.5" />
          </Button>
        </div>
      </div>

      {notice ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center">
          <div className="pointer-events-auto">{notice}</div>
        </div>
      ) : editable ? (
        <span className="pointer-events-none absolute bottom-4 left-1/2 z-10 hidden -translate-x-1/2 items-center gap-1.5 text-[11px] text-faint md:inline-flex">
          <MousePointer2 className="size-3" />
          {linkFrom ? "Click a target element to connect · Esc cancels" : "Drag to move · N new · Del removes · ⌘ scroll zooms"}
        </span>
      ) : null}

      {selectedNode && editable && linkFrom === selectedNode.id ? (
        <div className="control-glass absolute top-3 left-1/2 z-20 -translate-x-1/2 rounded-lg px-2.5 py-1 text-[12px] text-primary">
          connecting from {selectedNode.label}
        </div>
      ) : null}
    </div>
  );
}

const EMPTY: ReadonlySet<string> = new Set();
