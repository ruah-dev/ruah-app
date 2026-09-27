// Small form pieces of the Journeys page: labelled fields, inputs and text areas that keep a local
// draft and commit on blur (one product.save per field, not per keystroke), and the pickers.
import { useEffect, useState, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ProductFile } from "@/lib/contracts";
import { cn } from "@/lib/utils";

/** Journey colours (flow map arrows, list dots): 8 slots, by journey order. */
export const JOURNEY_COLORS = [
  "var(--node-service)",
  "var(--node-frontend)",
  "var(--node-data)",
  "var(--node-queue)",
  "var(--node-gateway)",
  "var(--node-step)",
  "var(--node-file)",
  "var(--ai)",
] as const;

export function Field({ label, hint, htmlFor, children, className }: { label: string; hint?: ReactNode; htmlFor?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1", className)}>
      <Label htmlFor={htmlFor} className="flex items-center justify-between gap-2 text-label font-medium text-muted-foreground">
        {label}
        {hint ? <span className="text-label font-normal text-faint">{hint}</span> : null}
      </Label>
      {children}
    </div>
  );
}

const inputClass = "h-8 rounded-md border-hairline bg-transparent px-2.5 text-ui-sm text-foreground shadow-none";

export function DraftInput({
  id,
  value,
  onCommit,
  placeholder,
  disabled,
  label,
  maxLength,
}: {
  id?: string;
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  label?: string;
  maxLength?: number;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Input
      id={id}
      aria-label={label}
      value={draft}
      disabled={disabled === true}
      placeholder={placeholder}
      maxLength={maxLength}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
      className={inputClass}
    />
  );
}

export function DraftArea({
  id,
  value,
  onCommit,
  placeholder,
  disabled,
  label,
  rows = 3,
  maxLength,
}: {
  id?: string;
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  label?: string;
  rows?: number;
  maxLength?: number;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Textarea
      id={id}
      aria-label={label}
      value={draft}
      rows={rows}
      disabled={disabled === true}
      placeholder={placeholder}
      maxLength={maxLength}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.target as HTMLTextAreaElement).blur();
      }}
      className="min-h-0 resize-y rounded-md border-hairline bg-transparent px-2.5 py-1.5 text-ui-sm leading-relaxed shadow-none"
    />
  );
}

const NONE = "__none__";

/** A select with a "none" choice: value null clears. */
export function OptionalSelect({
  label,
  value,
  options,
  none,
  onChange,
  disabled,
  className,
}: {
  label: string;
  value: string | undefined;
  options: { id: string; name: string }[];
  none: string;
  onChange: (value: string | null) => void;
  disabled?: boolean;
  className?: string;
}) {
  const known = value === undefined || options.some((o) => o.id === value);
  return (
    <Select value={value ?? NONE} disabled={disabled === true} onValueChange={(v) => onChange(v === NONE ? null : v)}>
      <SelectTrigger aria-label={label} className={cn("h-8 w-full gap-1.5 border-hairline bg-transparent px-2.5 text-ui-sm", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE} className="text-ui-sm text-muted-foreground">
          {none}
        </SelectItem>
        {!known && value !== undefined ? (
          <SelectItem value={value} className="text-ui-sm">
            {value}
          </SelectItem>
        ) : null}
        {options.map((o) => (
          <SelectItem key={o.id} value={o.id} className="text-ui-sm">
            {o.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function screenOptions(product: ProductFile): { id: string; name: string }[] {
  return product.screens.map((s) => ({ id: s.id, name: s.route !== undefined ? `${s.name} · ${s.route}` : s.name }));
}

export function personaOptions(product: ProductFile): { id: string; name: string }[] {
  return product.personas.map((p) => ({ id: p.id, name: p.name }));
}

/** "core" → pill tone and label. */
export function priorityPill(priority: string | undefined): { className: string; label: string } | null {
  if (priority === "core") return { className: "pill-primary", label: "Core" };
  if (priority === "secondary") return { className: "pill-info", label: "Secondary" };
  if (priority === "edge") return { className: "pill-warn", label: "Edge case" };
  return null;
}
