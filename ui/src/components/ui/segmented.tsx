// Small segmented control (Cursor / t3code style): a muted track, the active item raised. One
// choice of a few ("Cost | Tokens | Limits", "View | Edit").
//
// Two kinds, one look:
// - "radio" (default) — a setting or a filter: a radio group; the arrow keys (and Home / End)
//   move the choice.
// - "tabs" — a view switcher (the map side panel's Agent / Details / Code, Extensions' Installed /
//   Discover): a tab list with manual activation; the arrows move the focus, Enter / Space show
//   that view, so an arrow never swaps what is on screen by surprise.
//
// Keyboard: one Tab stop (the chosen item, or the first enabled one when nothing is chosen). A
// mouse click does not move the focus onto the item (as on macOS), so a click on "Edit" or
// "Details" leaves the arrow keys to the map instead of silently switching the mode or the view.
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type SegmentedOption<T extends string> = {
  value: T;
  label: ReactNode;
  disabled?: boolean | undefined;
  title?: string | undefined;
};

/** The index the arrow / Home / End key moves to, skipping disabled options; null = not a move key. */
export function segmentedStep(
  key: string,
  current: number,
  disabled: readonly boolean[],
): number | null {
  const n = disabled.length;
  if (n === 0) return null;
  const enabled = (i: number) => !disabled[i];
  const scan = (from: number, dir: 1 | -1): number | null => {
    for (let k = 1; k <= n; k++) {
      const i = (((from + dir * k) % n) + n) % n;
      if (enabled(i)) return i;
    }
    return null;
  };
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return scan(current, 1);
    case "ArrowLeft":
    case "ArrowUp":
      return scan(current, -1);
    case "Home":
      return scan(-1, 1);
    case "End":
      return scan(n, -1);
    default:
      return null;
  }
}

/**
 * The item that takes the group's one Tab stop: the chosen one when it is enabled, else the first
 * enabled item (a value that matches no option, or a disabled choice, must not leave the group
 * unreachable). -1 when every item is disabled.
 */
export function segmentedTabStop(values: readonly string[], disabled: readonly boolean[], value: string): number {
  const chosen = values.indexOf(value);
  if (chosen >= 0 && !disabled[chosen]) return chosen;
  return disabled.findIndex((d) => !d);
}

/**
 * The Segmented keyboard for a hand-styled row of buttons (filter pills, a bar of tabs): one Tab
 * stop, arrows / Home / End move the focus — and, in "radio" mode, the choice. Spread
 * `groupProps` on the container and `itemProps(i)` on each button (after its own props).
 */
export function useSegmentedKeys<T extends string>(
  values: readonly T[],
  value: T,
  onChange: (v: T) => void,
  kind: "radio" | "tabs" = "radio",
  disabledItems?: readonly boolean[],
) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const disabled = disabledItems ?? values.map(() => false);
  const stop = segmentedTabStop(values, disabled, value);
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    // Move from the item that has the focus (in a tab list it can differ from the chosen one).
    const focused = refs.current.findIndex((el) => el !== null && el === e.target);
    const next = segmentedStep(e.key, focused >= 0 ? focused : Math.max(0, stop), disabled);
    if (next === null) return;
    e.preventDefault();
    const target = values[next];
    if (target === undefined) return;
    if (kind === "radio") onChange(target);
    refs.current[next]?.focus();
  };
  return {
    groupProps: { role: kind === "tabs" ? "tablist" : "radiogroup", onKeyDown } as const,
    itemProps: (i: number) => {
      const on = values[i] === value;
      return {
        ref: (el: HTMLButtonElement | null) => {
          refs.current[i] = el;
        },
        role: kind === "tabs" ? "tab" : "radio",
        ...(kind === "tabs" ? { "aria-selected": on } : { "aria-checked": on }),
        tabIndex: i === stop ? 0 : -1,
      } as const;
    },
  };
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
  label,
  kind = "radio",
}: {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (v: T) => void;
  className?: string;
  /** Accessible name of the group ("Chart metric", "Panel view") — required: a radio group or a
   * tab list without a name is announced as just "group". */
  label: string;
  /** "radio": a choice (arrows move it). "tabs": a view switcher (arrows move the focus). */
  kind?: "radio" | "tabs";
}) {
  const keys = useSegmentedKeys(
    options.map((o) => o.value),
    value,
    onChange,
    kind,
    options.map((o) => o.disabled === true),
  );
  return (
    <div
      {...keys.groupProps}
      aria-label={label}
      className={cn("flex h-7 shrink-0 items-center gap-0.5 rounded-lg bg-surface-2 p-0.5 ring-1 ring-hairline", className)}
    >
      {options.map((o, i) => {
        const on = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            {...keys.itemProps(i)}
            disabled={o.disabled}
            title={o.title}
            // A mouse click chooses without taking the focus (keyboard users Tab here instead).
            onMouseDown={(e) => {
              if (e.button === 0) e.preventDefault();
            }}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex h-6 cursor-pointer items-center gap-1 rounded-md px-2.5 text-ui-sm whitespace-nowrap transition-colors max-sm:px-2 disabled:cursor-not-allowed disabled:opacity-50",
              on ? "bg-surface-4 text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
