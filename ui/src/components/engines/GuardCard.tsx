// Guard card for the element inspector. Report only — it never changes permissions.
import { useEffect, useState } from "react";
import { Shield } from "lucide-react";
import { engineStatus, guardAudit, guardScan, type EngineToolStatus, type GuardAudit, type GuardScan } from "@/lib/engines";
import { Button } from "@/components/ui/button";

export function GuardCard({ compact = false }: { compact?: boolean }) {
  const [tool, setTool] = useState<EngineToolStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [scan, setScan] = useState<GuardScan | { error: string } | null>(null);
  const [audit, setAudit] = useState<GuardAudit | { error: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void engineStatus().then((status) => {
      if (!cancelled) setTool(status["guard"] ?? { installed: false, install: "npm i -g @ruah-dev/cli @ruah-dev/guard" });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const installed = tool?.installed === true;
  const install = tool?.install ?? "npm i -g @ruah-dev/cli @ruah-dev/guard";

  async function run() {
    setBusy(true);
    try {
      const [nextScan, nextAudit] = await Promise.all([guardScan(), guardAudit()]);
      setScan(nextScan);
      setAudit(nextAudit);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={compact ? "contents" : "flex flex-col gap-2"}>
      {!compact ? (
        <>
          <h3 className="text-[12px] font-medium text-foreground">Guard</h3>
          <p className="text-[11px] text-muted-foreground">
            Scans the working tree for secrets and policy findings, then shows the audit log. It only reports.
          </p>
        </>
      ) : null}
      <Button size="sm" variant={compact ? "secondary" : "default"} disabled={!installed || busy} title={installed ? "Scan the working tree" : install} onClick={() => void run()}>
        <Shield className="size-3.5" />
        {busy ? "Scanning…" : "Guard"}
      </Button>
      {tool && !installed ? <p className="text-[11px] text-muted-foreground">Not installed. {install}</p> : null}
      {scan && "error" in scan ? <p className="text-[11px] text-bad">{scan.error}</p> : null}
      {scan && "summary" in scan ? (
        <p className="text-[11px] text-muted-foreground">
          {scan.summary?.total ?? 0} finding(s) in {scan.summary?.filesScanned ?? 0} file(s)
          {scan.summary?.failed ? " — review before sharing" : ""}.
        </p>
      ) : null}
      {audit && "entries" in audit ? (
        <p className="text-[11px] text-muted-foreground">{audit.count ?? audit.entries?.length ?? 0} audit entries.</p>
      ) : null}
    </div>
  );
}
