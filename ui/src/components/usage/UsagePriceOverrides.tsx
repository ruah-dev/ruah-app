// Adapted from t3code apps/web/src/components/usage/UsagePriceOverrides.tsx, usagePriceTable.ts
// and usagePriceTargets.ts (MIT): a table of per-model rates (USD per 1M tokens) used when the
// daemon cannot price a model. t3code writes them to each environment's server settings; Ruah
// keeps them in this browser (localStorage), so there is one target and no partial saves.
import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { readPrices, writePrices, type ModelPrice } from "@/lib/usage";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { parseUsagePriceForm, usagePriceForm, USAGE_PRICE_FIELDS, type UsagePriceForm } from "./usagePriceForm";

type Row = UsagePriceForm & { id: string; isNew: boolean };

let seq = 0;
const rowId = () => `row-${(seq += 1)}`;

export function UsagePriceOverrides({
  open,
  onOpenChange,
  models,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Models seen in usage (suggested rows). */
  models: readonly string[];
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [errors, setErrors] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    if (!open) return;
    const prices = readPrices();
    const ids = [...new Set([...Object.keys(prices), ...models])];
    setRows(ids.map((m) => ({ ...usagePriceForm(m, prices[m]), id: rowId(), isNew: false })));
    setErrors(new Map());
  }, [open, models]);

  const update = (id: string, patch: Partial<UsagePriceForm>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const save = () => {
    const next: Record<string, ModelPrice> = {};
    const errs = new Map<string, string>();
    for (const r of rows) {
      const blank = USAGE_PRICE_FIELDS.every((f) => r[f.key].trim() === "");
      if (blank) continue; // an untouched row means "automatic"
      const parsed = parseUsagePriceForm(r);
      if (!parsed) {
        const missing = USAGE_PRICE_FIELDS.find((f) => !f.optional && r[f.key].trim() === "");
        errs.set(
          r.id,
          r.model.trim() === ""
            ? "Enter a model ID."
            : missing
              ? `${missing.label} is required.`
              : "Use non-negative numbers for prices.",
        );
        continue;
      }
      next[parsed.model] = parsed.price;
    }
    setErrors(errs);
    if (errs.size) return;
    writePrices(next);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-0 p-0">
        <div className="px-6 pt-6 pb-4">
          <DialogTitle className="text-headline font-semibold">Model prices</DialogTitle>
          <DialogDescription className="mt-1 text-ui">
            USD per million tokens, used to estimate cost when the agent does not report it. Blank
            cache rates use the input rate. Stored in this browser.
          </DialogDescription>
        </div>
        <div className="max-h-[50vh] overflow-y-auto px-6">
          <table className="w-full table-fixed text-ui-sm">
            <colgroup>
              <col className="w-[34%]" />
              {USAGE_PRICE_FIELDS.map((f) => (
                <col key={f.key} className="w-[15%]" />
              ))}
              <col className="w-8" />
            </colgroup>
            <thead>
              <tr className="border-b border-hairline text-left text-label text-muted-foreground">
                <th className="py-2 font-normal">Model</th>
                {USAGE_PRICE_FIELDS.map((f) => (
                  <th key={f.key} className="py-2 pe-2 text-right font-normal">
                    {f.label}
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-muted-foreground">
                    No models yet. Add one to set its price.
                  </td>
                </tr>
              ) : null}
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-hairline/60 align-top">
                  <td className="py-1.5 pe-2">
                    {r.isNew ? (
                      <input
                        value={r.model}
                        onChange={(e) => update(r.id, { model: e.target.value })}
                        placeholder="model-id"
                        className="h-7 w-full rounded-md bg-foreground/[0.05] px-2 font-mono text-label outline-none focus:ring-1 focus:ring-ring"
                      />
                    ) : (
                      <span className="block truncate py-1 font-mono text-label" title={r.model}>
                        {r.model}
                      </span>
                    )}
                    {errors.get(r.id) ? (
                      <span className="mt-0.5 block text-meta text-bad">{errors.get(r.id)}</span>
                    ) : null}
                  </td>
                  {USAGE_PRICE_FIELDS.map((f) => (
                    <td key={f.key} className="py-1.5 pe-2">
                      <input
                        inputMode="decimal"
                        value={r[f.key]}
                        onChange={(e) => update(r.id, { [f.key]: e.target.value })}
                        placeholder={f.optional ? "Input" : "Auto"}
                        className={cn(
                          "h-7 w-full rounded-md bg-foreground/[0.05] px-2 text-right text-label tabular-nums outline-none placeholder:text-faint focus:ring-1 focus:ring-ring",
                        )}
                      />
                    </td>
                  ))}
                  <td className="py-1.5">
                    <button
                      type="button"
                      aria-label={`Clear ${r.model || "row"}`}
                      onClick={() =>
                        r.isNew
                          ? setRows((rs) => rs.filter((x) => x.id !== r.id))
                          : update(r.id, usagePriceForm(r.model))
                      }
                      className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      <X className="size-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center gap-2 px-6 py-4">
          <button
            type="button"
            onClick={() => setRows((rs) => [...rs, { ...usagePriceForm(), id: rowId(), isNew: true }])}
            className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-ui text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Plus className="size-3.5" /> Add model
          </button>
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="h-8 rounded-lg px-3 text-ui text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            className="h-8 rounded-lg bg-primary px-3.5 text-ui font-medium text-primary-foreground hover:bg-primary/90"
          >
            Save prices
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
