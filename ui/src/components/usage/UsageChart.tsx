// Adapted from t3code apps/web/src/components/usage/UsageProviderChart.tsx (MIT): layered
// monotone area lines per agent, a readable 1/2/5 scale, hover readout. Providers became
// agents; colours come from the design tokens.
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatDayShort, formatHourShort, formatTokens, formatUsd } from "@/lib/usage";
import { AgentMark } from "@/components/agent/ComposerControls";

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 260;
const TICK_COUNT = 4;
const PLOT_TOP = 8;

export type UsageChartMetric = "tokens" | "cost";

/** One bucket's value per agent. */
export type ChartColumn = { values: Map<string, number>; total: number };

interface Point {
  readonly x: number;
  readonly y: number;
}

/** Shape-preserving cubic tangents that cannot overshoot spiky usage data. */
function monotoneTangents(points: readonly Point[]): readonly number[] {
  const count = points.length;
  if (count < 2) return [0];
  const slopes: number[] = [];
  for (let i = 0; i < count - 1; i += 1) {
    const dx = points[i + 1]!.x - points[i]!.x;
    const dy = points[i + 1]!.y - points[i]!.y;
    slopes.push(dx === 0 ? 0 : dy / dx);
  }
  const tangents: number[] = Array.from({ length: count }, () => 0);
  tangents[0] = slopes[0] ?? 0;
  tangents[count - 1] = slopes[count - 2] ?? 0;
  for (let i = 1; i < count - 1; i += 1) {
    const prev = slopes[i - 1] ?? 0;
    const next = slopes[i] ?? 0;
    tangents[i] = prev * next <= 0 ? 0 : (prev + next) / 2;
  }
  for (let i = 0; i < count - 1; i += 1) {
    const slope = slopes[i] ?? 0;
    if (slope === 0) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
      continue;
    }
    const a = (tangents[i] ?? 0) / slope;
    const b = (tangents[i + 1] ?? 0) / slope;
    const magnitude = a * a + b * b;
    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude);
      tangents[i] = scale * a * slope;
      tangents[i + 1] = scale * b * slope;
    }
  }
  return tangents;
}

function curvePath(points: readonly Point[]): string {
  if (points.length < 2) return "";
  const t = monotoneTangents(points);
  let path = `M${points[0]!.x.toFixed(2)},${points[0]!.y.toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const from = points[i]!;
    const to = points[i + 1]!;
    const dx = to.x - from.x;
    const c1 = { x: from.x + dx / 3, y: from.y + ((t[i] ?? 0) * dx) / 3 };
    const c2 = { x: to.x - dx / 3, y: to.y - ((t[i + 1] ?? 0) * dx) / 3 };
    path += ` C${c1.x.toFixed(2)},${c1.y.toFixed(2)} ${c2.x.toFixed(2)},${c2.y.toFixed(2)} ${to.x.toFixed(2)},${to.y.toFixed(2)}`;
  }
  return path;
}

/** A readable 1/2/5 × 10^n maximum at or above the peak, so the peak is never clipped. */
export function niceScale(peak: number, count: number): { max: number; ticks: readonly number[] } {
  if (peak <= 0) return { max: 0, ticks: [0] };
  const rawStep = peak / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;
  const max = Math.ceil(peak / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 1e-6; v += step) ticks.push(v);
  return { max, ticks };
}

export function UsageChart({
  agents,
  labels,
  colors,
  buckets,
  columns,
  metric,
  resolution,
}: {
  agents: readonly string[];
  labels: ReadonlyMap<string, string>;
  colors: ReadonlyMap<string, string>;
  buckets: readonly string[];
  columns: readonly ChartColumn[];
  metric: UsageChartMetric;
  resolution: "day" | "hour";
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const hoverPositionRef = useRef<{ x: number; y: number } | null>(null);

  const { paths, ticks, stepX, toY } = useMemo(() => {
    if (buckets.length === 0)
      return { paths: [], ticks: [0] as readonly number[], stepX: 0, toY: () => VIEW_HEIGHT };
    // Layered series each measure from zero, so the scale tops out at the largest single value.
    const peak = columns.reduce(
      (max, c) => agents.reduce((inner, a) => Math.max(inner, c.values.get(a) ?? 0), max),
      0,
    );
    const { max, ticks } = niceScale(peak, TICK_COUNT);
    const step = buckets.length === 1 ? 0 : VIEW_WIDTH / (buckets.length - 1);
    const toY = (v: number) =>
      max === 0 ? VIEW_HEIGHT : VIEW_HEIGHT - (v / max) * (VIEW_HEIGHT - PLOT_TOP);
    const built = agents.map((agent) => {
      const line = curvePath(
        columns.map((c, i) => ({ x: i * step, y: toY(c.values.get(agent) ?? 0) })),
      );
      return {
        agent,
        total: columns.reduce((s, c) => s + (c.values.get(agent) ?? 0), 0),
        area: line === "" ? "" : `${line} L${VIEW_WIDTH},${VIEW_HEIGHT} L0,${VIEW_HEIGHT} Z`,
        line,
      };
    });
    // Heavier series first so the lighter one is not buried.
    return { paths: built.sort((a, b) => b.total - a.total), ticks, stepX: step, toY };
  }, [agents, buckets, columns]);

  const format = metric === "tokens" ? formatTokens : formatUsd;
  const formatBucket = (b: string) => (resolution === "hour" ? formatHourShort(b) : formatDayShort(b));

  const positionTooltip = useCallback(() => {
    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    const pos = hoverPositionRef.current;
    if (!plot || !tooltip || !pos) return;
    const gap = 12;
    const w = tooltip.offsetWidth;
    const h = tooltip.offsetHeight;
    const left = pos.x + gap + w <= plot.clientWidth ? pos.x + gap : pos.x - gap - w;
    const top = pos.y + gap + h <= plot.clientHeight ? pos.y + gap : pos.y - gap - h;
    plot.style.setProperty(
      "--usage-tooltip-left",
      `${Math.min(Math.max(0, left), Math.max(0, plot.clientWidth - w))}px`,
    );
    plot.style.setProperty(
      "--usage-tooltip-top",
      `${Math.min(Math.max(0, top), Math.max(0, plot.clientHeight - h))}px`,
    );
  }, []);

  useLayoutEffect(() => {
    if (hoverIndex !== null) positionTooltip();
  }, [hoverIndex, positionTooltip]);

  const hovered = hoverIndex === null ? undefined : columns[hoverIndex];
  const hoveredBucket = hoverIndex === null ? undefined : buckets[hoverIndex];

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <div className="relative h-56 w-14 shrink-0">
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-0 -translate-y-1/2 text-[10.5px] text-muted-foreground tabular-nums"
              style={{ top: `${(toY(tick) / VIEW_HEIGHT) * 100}%` }}
            >
              {tick === 0 ? "0" : format(tick)}
            </span>
          ))}
        </div>
        <div
          ref={plotRef}
          className="relative h-56 flex-1"
          onMouseMove={(e) => {
            const plot = plotRef.current;
            if (!plot || buckets.length === 0) return;
            const r = plot.getBoundingClientRect();
            if (r.width === 0) return;
            const x = Math.min(r.width, Math.max(0, e.clientX - r.left));
            const y = Math.min(r.height, Math.max(0, e.clientY - r.top));
            hoverPositionRef.current = { x, y };
            positionTooltip();
            setHoverIndex(Math.round((x / r.width) * (buckets.length - 1)));
          }}
          onMouseLeave={() => {
            hoverPositionRef.current = null;
            setHoverIndex(null);
          }}
        >
          <svg
            className="h-full w-full"
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`${resolution === "hour" ? "Hourly" : "Daily"} ${metric === "tokens" ? "tokens" : "cost"} by agent`}
          >
            {ticks.map((tick) => (
              <line
                key={tick}
                x1={0}
                x2={VIEW_WIDTH}
                y1={toY(tick)}
                y2={toY(tick)}
                stroke="var(--hairline)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {paths.map(({ agent, area }) => (
              <path key={agent} d={area} fill={colors.get(agent)} fillOpacity={0.12} />
            ))}
            {paths.map(({ agent, line }) => (
              <path
                key={agent}
                d={line}
                fill="none"
                stroke={colors.get(agent)}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {hoverIndex === null ? null : (
              <line
                x1={hoverIndex * stepX}
                x2={hoverIndex * stepX}
                y1={PLOT_TOP}
                y2={VIEW_HEIGHT}
                stroke="var(--muted-foreground)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
          {hoveredBucket === undefined ? null : (
            <div
              ref={tooltipRef}
              className="pointer-events-none absolute z-10 min-w-40 max-w-full rounded-xl border border-hairline bg-popover px-2.5 py-2 text-[12px] shadow-xl"
              style={{ left: "var(--usage-tooltip-left, 0px)", top: "var(--usage-tooltip-top, 0px)" }}
            >
              <div className="mb-1 text-muted-foreground">{formatBucket(hoveredBucket)}</div>
              {agents.map((a) => (
                <div key={a} className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span className="size-2 rounded-full" style={{ backgroundColor: colors.get(a) }} />
                    <AgentMark name={labels.get(a) ?? a} className="size-3.5 text-[7px]" />
                    {labels.get(a) ?? a}
                  </span>
                  <span className="text-foreground tabular-nums">
                    {format(hovered?.values.get(a) ?? 0)}
                  </span>
                </div>
              ))}
              <div className="mt-1 flex items-center justify-between gap-3 border-t border-hairline pt-1">
                <span className="text-muted-foreground">Total</span>
                <span className="text-foreground tabular-nums">{format(hovered?.total ?? 0)}</span>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="flex justify-between pl-16 text-[10.5px] text-muted-foreground">
        <span>{buckets[0] ? formatBucket(buckets[0]) : ""}</span>
        <span>{buckets[Math.floor(buckets.length / 2)] ? formatBucket(buckets[Math.floor(buckets.length / 2)]!) : ""}</span>
        <span>{buckets.length ? formatBucket(buckets[buckets.length - 1]!) : ""}</span>
      </div>
    </div>
  );
}
