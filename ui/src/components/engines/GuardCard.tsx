// Guard card for the element inspector. Report only — it never changes permissions.
// `compact` is the one-button form for a page header (Tasks): no text in the row — the result is
// a toast, and without the tool the button says how to install it (tooltip) instead of a line
// of text that would push the header's other controls around.
import { useState } from "react";
import { Shield } from "lucide-react";
import { toast } from "sonner";
import { guardAudit, guardScan, useEngineTool, type GuardAudit, type GuardScan } from "@/lib/engines";
import { Button } from "@/components/ui/button";
import { solidButton } from "@/components/ui/controls";

/** The one-line result of a scan (+ audit) for a toast. */
export function guardSummary(scan: GuardScan | { error: string }, audit: GuardAudit | { error: string } | null): { ok: boolean; text: string } {
  if ("error" in scan) return { ok: false, text: `Guard couldn't scan: ${scan.error}` };
  const total = scan.summary?.total ?? 0;
  const files = scan.summary?.filesScanned ?? 0;
  const entries = audit && "entries" in audit ? (audit.count ?? audit.entries?.length ?? 0) : null;
  const head = `${total} finding${total === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}`;
  return {
    ok: !scan.summary?.failed,
    text: `${head}${scan.summary?.failed ? " — review before sharing" : ""}${entries !== null ? ` · ${entries} audit entries` : ""}.`,
  };
}

export function GuardCard({ compact = false }: { compact?: boolean }) {
  const { tool, connected } = useEngineTool("guard");
  const [busy, setBusy] = useState(false);
  const [scan, setScan] = useState<GuardScan | { error: string } | null>(null);
  const [audit, setAudit] = useState<GuardAudit | { error: string } | null>(null);

  const installed = tool?.installed === true;
  const install = tool?.install ?? "npm i -g @ruah-dev/cli @ruah-dev/guard";

  async function run() {
    setBusy(true);
    try {
      const [nextScan, nextAudit] = await Promise.all([guardScan(), guardAudit()]);
      setScan(nextScan);
      setAudit(nextAudit);
      if (compact) {
        const r = guardSummary(nextScan, nextAudit);
        if (r.ok) toast.success(r.text);
        else toast.warning(r.text);
      }
    } finally {
      setBusy(false);
    }
  }

  if (compact) {
    return (
      <button
        type="button"
        className={solidButton}
        disabled={busy || tool === null}
        aria-disabled={!installed || undefined}
        title={installed ? "Scan the working tree for secrets and policy findings (report only)" : `Guard isn't installed — ${install}`}
        onClick={() => {
          if (installed) void run();
          else toast.info(`Guard isn't installed. Install it with: ${install}`);
        }}
      >
        <Shield className="size-3.5" />
        {busy ? "Scanning…" : "Guard"}
      </button>
    );
  }

  return (
    <div className={compact ? "contents" : "flex flex-col gap-2"}>
      {!compact ? (
        <>
          <h3 className="text-label font-medium text-foreground">Guard</h3>
          <p className="text-caption text-muted-foreground">
            Scans the working tree for secrets and policy findings, then shows the audit log. It only reports.
          </p>
        </>
      ) : null}
      <Button
        size="sm"
        variant={compact ? "secondary" : "default"}
        disabled={!installed || busy}
        title={!connected ? "Needs the Ruah daemon (open a project)" : installed ? "Scan the working tree" : install}
        onClick={() => void run()}
      >
        <Shield className="size-3.5" />
        {busy ? "Scanning…" : "Guard"}
      </Button>
      {tool && !installed ? <p className="text-caption text-muted-foreground">Not installed. {install}</p> : null}
      {scan && "error" in scan ? <p className="text-caption text-bad">{scan.error}</p> : null}
      {scan && "summary" in scan ? (
        <p className="text-caption text-muted-foreground">
          {scan.summary?.total ?? 0} finding(s) in {scan.summary?.filesScanned ?? 0} file(s)
          {scan.summary?.failed ? " — review before sharing" : ""}.
        </p>
      ) : null}
      {audit && "entries" in audit ? (
        <p className="text-caption text-muted-foreground">{audit.count ?? audit.entries?.length ?? 0} audit entries.</p>
      ) : null}
    </div>
  );
}
