// Minimal windowed list (no dependency): rows have known heights (per item), only the rows in
// view plus an overscan are mounted. Used for chats, recent projects and the repo tree.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

type Props<T> = {
  items: readonly T[];
  /** Row height in px: a constant, or per item (e.g. group headers vs rows). */
  itemHeight: number | ((item: T, index: number) => number);
  renderItem: (item: T, index: number) => ReactNode;
  getKey: (item: T, index: number) => string;
  /** Keep this row visible (keyboard navigation). */
  activeIndex?: number;
  overscan?: number;
  className?: string;
  style?: CSSProperties;
  /** Render everything below this count (cheap, keeps find-in-page working for short lists). */
  windowAbove?: number;
  role?: string;
  "aria-label"?: string;
  id?: string;
};

export function VirtualList<T>({
  items,
  itemHeight,
  renderItem,
  getKey,
  activeIndex,
  overscan = 6,
  className,
  style,
  windowAbove = 40,
  role,
  id,
  "aria-label": ariaLabel,
}: Props<T>) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(400);

  const offsets = useMemo(() => {
    const out = new Array<number>(items.length + 1);
    out[0] = 0;
    for (let i = 0; i < items.length; i++) {
      const h = typeof itemHeight === "number" ? itemHeight : itemHeight(items[i]!, i);
      out[i + 1] = out[i]! + h;
    }
    return out;
  }, [items, itemHeight]);
  const total = offsets[items.length] ?? 0;
  const windowed = items.length > windowAbove;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setViewport(el.clientHeight || 400);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight || 400));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (el) setScrollTop(el.scrollTop);
  }, []);

  // Scroll the active row into view.
  useEffect(() => {
    const el = ref.current;
    if (!el || activeIndex === undefined || activeIndex < 0 || activeIndex >= items.length) return;
    const top = offsets[activeIndex]!;
    const bottom = offsets[activeIndex + 1]!;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }, [activeIndex, offsets, items.length]);

  let start = 0;
  let end = items.length;
  if (windowed) {
    // binary search the first row whose bottom is below scrollTop
    let lo = 0;
    let hi = items.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid + 1]! <= scrollTop) lo = mid + 1;
      else hi = mid;
    }
    start = Math.max(0, lo - overscan);
    end = start;
    while (end < items.length && offsets[end]! < scrollTop + viewport) end++;
    end = Math.min(items.length, end + overscan);
  }

  const rows: ReactNode[] = [];
  for (let i = start; i < end; i++) {
    const item = items[i]!;
    rows.push(
      <div
        key={getKey(item, i)}
        style={
          windowed
            ? { position: "absolute", top: offsets[i], left: 0, right: 0, height: offsets[i + 1]! - offsets[i]! }
            : { height: offsets[i + 1]! - offsets[i]! }
        }
      >
        {renderItem(item, i)}
      </div>,
    );
  }

  return (
    <div
      ref={ref}
      id={id}
      role={role}
      aria-label={ariaLabel}
      onScroll={windowed ? onScroll : undefined}
      className={cn("min-h-0 overflow-y-auto", className)}
      style={style}
    >
      {windowed ? <div style={{ position: "relative", height: total }}>{rows}</div> : rows}
    </div>
  );
}
