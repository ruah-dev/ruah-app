// Optimize section for the Usage page. Hidden work when ruah-opt is not installed.
import { useEffect, useState } from "react";
import { engineStatus, optUsage, type EngineToolStatus, type OptUsage } from "@/lib/engines";
import { Button } from "@/components/ui/button";

export function OptimizeSection() {
  const [tool, setTool] = useState<EngineToolStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<OptUsage | { error: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void engineStatus().then((status) => {
      if (!cancelled) setTool(status["opt"] ?? { installed: false, install: "npm i -g @ruah-dev/cli @ruah-dev/opt" });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const installed = tool?.installed === true;
  const install = tool?.install ?? "npm i -g @ruah-dev/cli @ruah-dev/opt";

  return (
    <section className="flex flex-col gap-3 border-t border-hairline pt-6">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="heading text-[16px] text-foreground">Optimize</h2>
        <Button
          size="sm"
          variant="secondary"
          disabled={!installed || busy}
          title={installed ? "Summarize ~/.ruah/usage.jsonl" : install}
          onClick={() => {
            setBusy(true);
            void optUsage()
              .then(setReport)
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Analyzing…" : "Run opt"}
        </Button>
      </div>
      <p className="text-[12px] text-muted-foreground">
        Top spenders, waste signals, and suggestions from the usage log via <code>ruah opt usage</code>.
      </p>
      {tool && !installed ? <p className="text-[12px] text-muted-foreground">Not installed. {install}</p> : null}
      {report && "error" in report ? <p className="text-[12px] text-bad">{report.error}</p> : null}
      {report && "topSpenders" in report ? (
        <div className="flex flex-col gap-2 text-[12px]">
          <p className="text-muted-foreground">
            {report.records} turn(s) · {report.summary.totalTokens} tokens · ${report.summary.costUsd.toFixed(4)}
          </p>
          {report.topSpenders.slice(0, 5).map((s) => (
            <p key={`${s.by}:${s.key}`}>
              {s.by} <span className="font-medium">{s.key}</span> — {s.tokens} tokens, ${s.costUsd.toFixed(4)}
            </p>
          ))}
          {report.waste.map((w) => (
            <p key={w.signal} className="text-warn">
              {w.signal}: {w.detail}
            </p>
          ))}
          {report.suggestions.map((s) => (
            <p key={s} className="text-muted-foreground">
              {s}
            </p>
          ))}
        </div>
      ) : null}
    </section>
  );
}
