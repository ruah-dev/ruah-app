// Minimap: every element of the level as a tiny coloured block on a <canvas>, the viewport as a
// frame. Click or drag to move the camera there. Redrawn imperatively on camera changes (the
// parent calls `draw`), so panning never re-renders React.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import type { DiagramNode } from "@/data/graphs";
import { styleFor } from "@/components/explorer/kinds";
import { boundsOf, nodeBox, viewRect, type Box, type Camera } from "./geometry";

export type MinimapHandle = { draw: (cam: Camera, vw: number, vh: number) => void };

const W = 184;
const H = 116;

function cssVar(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

type Props = {
  nodes: readonly DiagramNode[];
  selectedId: string | null;
  matches: ReadonlySet<string>;
  onJump: (worldX: number, worldY: number) => void;
};

export const Minimap = forwardRef<MinimapHandle, Props>(function Minimap({ nodes, selectedId, matches, onJump }, ref) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const last = useRef<{ cam: Camera; vw: number; vh: number } | null>(null);
  const world = useMemo<Box | null>(() => {
    const b = boundsOf(nodes.map(nodeBox));
    if (!b) return null;
    const pad = Math.max(b.w, b.h) * 0.06 + 40;
    return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
  }, [nodes]);
  const colors = useMemo(() => {
    const cache = new Map<string, string>();
    return (n: DiagramNode) => {
      const token = styleFor(n).bar.replace(/^bg-/, "--");
      let c = cache.get(token);
      if (!c) {
        c = cssVar(token, "#8f8a7e");
        cache.set(token, c);
      }
      return c;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes]);

  const scaleOf = useCallback(() => {
    if (!world) return null;
    const s = Math.min(W / world.w, H / world.h);
    return { s, ox: (W - world.w * s) / 2 - world.x * s, oy: (H - world.h * s) / 2 - world.y * s };
  }, [world]);

  const draw = useCallback(
    (cam: Camera, vw: number, vh: number) => {
      last.current = { cam, vw, vh };
      const cv = canvasRef.current;
      const t = scaleOf();
      if (!cv || !t) return;
      const dpr = window.devicePixelRatio || 1;
      if (cv.width !== W * dpr) {
        cv.width = W * dpr;
        cv.height = H * dpr;
      }
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      for (const n of nodes) {
        const b = nodeBox(n);
        const hot = n.id === selectedId || matches.has(n.id);
        ctx.globalAlpha = hot ? 1 : matches.size > 0 ? 0.45 : 0.8;
        ctx.fillStyle = hot && n.id !== selectedId ? cssVar("--warn", "#e5a84b") : colors(n);
        ctx.fillRect(t.ox + b.x * t.s, t.oy + b.y * t.s, Math.max(1.5, b.w * t.s), Math.max(1.5, b.h * t.s));
      }
      ctx.globalAlpha = 1;
      const v = viewRect(cam, vw, vh);
      ctx.strokeStyle = cssVar("--primary", "#00bea8");
      ctx.lineWidth = 1.25;
      ctx.strokeRect(t.ox + v.x * t.s + 0.5, t.oy + v.y * t.s + 0.5, v.w * t.s, v.h * t.s);
    },
    [nodes, selectedId, matches, colors, scaleOf],
  );

  useImperativeHandle(ref, () => ({ draw }), [draw]);
  useEffect(() => {
    if (last.current) draw(last.current.cam, last.current.vw, last.current.vh);
  }, [draw]);

  const jump = (e: React.PointerEvent) => {
    const t = scaleOf();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!t || !rect) return;
    onJump((e.clientX - rect.left - t.ox) / t.s, (e.clientY - rect.top - t.oy) / t.s);
  };

  if (!world || nodes.length < 2) return null;
  return (
    <canvas
      ref={canvasRef}
      aria-label="Minimap: click to move the view"
      role="img"
      className="control-glass absolute bottom-3 left-3 z-20 cursor-crosshair rounded-lg"
      style={{ width: W, height: H }}
      onPointerDown={(e) => {
        e.stopPropagation();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        jump(e);
      }}
      onPointerMove={(e) => {
        if (e.buttons === 1) jump(e);
      }}
    />
  );
});
