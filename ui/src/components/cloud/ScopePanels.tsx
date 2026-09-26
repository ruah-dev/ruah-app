// §14 per-project cloud scope on the Cloud page: the "Looks related" suggestions (resources whose
// name looks like the project's) with Add / Dismiss, and the account picker — which of the
// connected providers' accounts belong to this project (only those are read for it; "whole
// account" makes everything in it the project's). Both write the repo's .ruah/cloud.json through
// the daemon; nothing here runs a provider CLI.
import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Plus, X } from "lucide-react";
import type { CloudResource, IntegrationInfo, ScopeAccount } from "@/lib/contracts";
import { providerLabel, type ScopeResourceAction } from "@/lib/integrations";
import { ProviderGlyph, primaryButton, quietButton, solidButton } from "@/components/integrations/common";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

const SHOWN = 6;

export function LooksRelated({
  resources,
  disabled,
  onScope,
}: {
  resources: CloudResource[];
  disabled?: boolean;
  onScope: (r: CloudResource, action: ScopeResourceAction) => void;
}) {
  const [open, setOpen] = useState(true);
  const [all, setAll] = useState(false);
  if (!resources.length) return null;
  const shown = all ? resources : resources.slice(0, SHOWN);
  return (
    <section aria-label="Looks related" className="rounded-xl border border-hairline bg-surface-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3.5 py-2 text-left"
        aria-expanded={open}
      >
        {open ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />}
        <span className="text-ui font-medium text-foreground">Looks related ({resources.length})</span>
        <span className="truncate text-label text-muted-foreground">
          Named like this project, but nothing in the repo proves it. Add what is yours.
        </span>
      </button>
      {open ? (
        <ul className="border-t border-hairline px-3.5 py-1">
          {shown.map((r) => (
            <li key={r.id} className="flex items-center gap-2.5 py-1.5">
              <ProviderGlyph id={r.provider} />
              <span className="min-w-0 truncate text-ui text-foreground" title={r.id}>
                {r.name}
              </span>
              <span className="shrink-0 font-mono text-caption text-faint">
                {providerLabel(r.provider)} · {r.service}
                {r.account ? ` · ${r.account}` : ""}
              </span>
              <span className="min-w-0 flex-1 truncate text-label text-muted-foreground">{r.scope?.reasons[0]}</span>
              <button type="button" className={solidButton} disabled={disabled} onClick={() => onScope(r, "include")}>
                <Plus className="size-3.5" /> Add
              </button>
              <button
                type="button"
                className={quietButton}
                disabled={disabled}
                onClick={() => onScope(r, "exclude")}
                title="Not this project's — hide it here"
              >
                <X className="size-3.5" /> Dismiss
              </button>
            </li>
          ))}
          {resources.length > SHOWN ? (
            <li className="py-1">
              <button type="button" className={quietButton} onClick={() => setAll((a) => !a)}>
                {all ? "Show fewer" : `Show all ${resources.length}`}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </section>
  );
}

const keyOf = (provider: string, account: string | undefined) => `${provider}\u0000${account ?? ""}`;

/**
 * Which accounts belong to this project, per connected provider (checkbox list). Providers
 * without an account list offer their selected account. "Whole account" = everything in it
 * is this project's; otherwise only what the repo proves (the account is just the only one read).
 */
export function AccountPicker({
  providers,
  current,
  defaultWhole,
  disabled,
  saving,
  onSave,
  onCancel,
  onShowAll,
}: {
  providers: IntegrationInfo[];
  current: ScopeAccount[];
  defaultWhole: boolean;
  disabled?: boolean;
  saving?: boolean;
  onSave: (accounts: ScopeAccount[]) => void;
  onCancel?: () => void;
  onShowAll?: () => void;
}) {
  const [picked, setPicked] = useState<Map<string, ScopeAccount>>(
    () => new Map(current.map((a) => [keyOf(a.provider, a.account), { ...a }])),
  );
  const rows = useMemo(
    () =>
      providers.map((p) => ({
        provider: p,
        accounts: p.accounts?.length
          ? p.accounts.map((a) => ({ id: a.id as string | undefined, label: a.label }))
          : [{ id: undefined as string | undefined, label: "Selected account" }],
      })),
    [providers],
  );
  const toggle = (provider: string, account: string | undefined, on: boolean) => {
    const key = keyOf(provider, account);
    setPicked((prev) => {
      const next = new Map(prev);
      if (on) next.set(key, { provider, ...(account !== undefined ? { account } : {}), ...(defaultWhole ? { whole: true } : {}) });
      else next.delete(key);
      return next;
    });
  };
  const setWhole = (provider: string, account: string | undefined, whole: boolean) => {
    const key = keyOf(provider, account);
    setPicked((prev) => {
      const entry = prev.get(key);
      if (!entry) return prev;
      const next = new Map(prev);
      const { whole: _w, ...rest } = entry;
      next.set(key, whole ? { ...rest, whole: true } : rest);
      return next;
    });
  };
  const changed =
    picked.size !== current.length ||
    current.some((a) => {
      const p = picked.get(keyOf(a.provider, a.account));
      return !p || !!p.whole !== !!a.whole;
    });

  return (
    <section aria-label="Project accounts" className="rounded-xl border border-hairline bg-surface-1 px-4 py-3.5">
      <p className="text-body font-medium text-foreground">Which accounts does this project live in?</p>
      <p className="mt-0.5 max-w-2xl text-ui-sm leading-relaxed text-muted-foreground">
        {defaultWhole ? "Nothing in the repo says where it runs yet. " : ""}Pick this project's accounts: only they are
        read for it, so other clients' resources never show up here. With <span className="text-foreground/90">whole account</span> on,
        everything in it counts as this project's; off, only what the repo proves (you can still add resources one by
        one). Saved in the repo's <code className="font-mono text-meta">.ruah/cloud.json</code> — no secrets.
      </p>
      {rows.length === 0 ? (
        <p className="mt-3 text-ui-sm text-muted-foreground">No cloud provider is connected.</p>
      ) : (
        <ul className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {rows.map(({ provider, accounts }) => (
            <li key={provider.id}>
              <p className="flex items-center gap-2 text-ui-sm font-medium text-foreground">
                <ProviderGlyph id={provider.id} /> {provider.name}
              </p>
              <ul className="mt-1 space-y-1 ps-5">
                {accounts.map((a) => {
                  const key = keyOf(provider.id, a.id);
                  const entry = picked.get(key);
                  const id = `scope-acct-${provider.id}-${a.id ?? "default"}`;
                  return (
                    <li key={key} className="flex min-h-7 items-center gap-2">
                      <Checkbox
                        id={id}
                        checked={!!entry}
                        disabled={disabled}
                        onCheckedChange={(v) => toggle(provider.id, a.id, v === true)}
                      />
                      <label htmlFor={id} className="min-w-0 flex-1 truncate text-ui-sm text-foreground/90" title={a.id ?? a.label}>
                        {a.label}
                      </label>
                      {entry ? (
                        <label className="flex shrink-0 items-center gap-1.5 text-meta text-muted-foreground">
                          <Switch
                            checked={!!entry.whole}
                            disabled={disabled}
                            onCheckedChange={(v) => setWhole(provider.id, a.id, v)}
                            aria-label={`Whole ${a.label} account belongs to this project`}
                            className="scale-75"
                          />
                          whole account
                        </label>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={primaryButton}
          disabled={disabled || saving || !changed}
          onClick={() => onSave([...picked.values()])}
        >
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Save and sync
        </button>
        {onCancel ? (
          <button type="button" className={quietButton} onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        <span className="flex-1" />
        {onShowAll ? (
          <button type="button" className={cn(quietButton)} onClick={onShowAll}>
            Browse all accounts instead
          </button>
        ) : null}
      </div>
    </section>
  );
}
