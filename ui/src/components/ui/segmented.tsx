// Small segmented control (Cursor / t3code style): a muted track, the active item raised. One
// choice of a few ("Cost | Tokens | Limits", "View | Edit"). Keyboard: it is one Tab stop; the
// arrow keys (and Home / End) move the choice, as a radio group does.
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

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
  label,
}: {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (v: T) => void;
  className?: string;
  /** Accessible name of the group ("Chart metric"). */
  label?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const active = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = segmentedStep(
      e.key,
      active,
      options.map((o) => o.disabled === true),
    );
    if (next === null) return;
    e.preventDefault();
    const option = options[next];
    if (!option) return;
    onChange(option.value);
    refs.current[next]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn("flex h-7 shrink-0 items-center gap-0.5 rounded-lg bg-surface-2 p-0.5 ring-1 ring-hairline", className)}
    >
      {options.map((o, i) => {
        const on = value === o.value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            disabled={o.disabled}
            title={o.title}
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
