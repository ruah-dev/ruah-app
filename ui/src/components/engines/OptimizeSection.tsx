// Optimize section for the Usage page. Quiet when ruah opt is missing: one line with the install
// command (copyable), no disabled button that cannot do anything.
import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { engineStatus, optUsage, type EngineToolStatus, type OptUsage } from "@/lib/engines";
import { solidButton } from "@/components/ui/controls";
import { CopyCommand } from "@/components/integrations/common";

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
        <h2 className="heading text-headline text-foreground">Optimize</h2>
        {installed ? (
          <button
            type="button"
            className={solidButton}
            disabled={busy}
            title="Summarize ~/.ruah/usage.jsonl with ruah opt"
            onClick={() => {
              setBusy(true);
              void optUsage()
                .then(setReport)
                .finally(() => setBusy(false));
            }}
          >
            <Sparkles className="size-3.5" />
            {busy ? "Analyzing…" : "Analyze usage"}
          </button>
        ) : null}
      </div>
      <p className="text-label text-muted-foreground">
        Top spenders, waste signals and suggestions from the usage log (<code className="font-mono">ruah opt usage</code>).
      </p>
      {tool && !installed ? (
        <div className="flex flex-wrap items-center gap-2 text-label text-muted-foreground">
          <span>Needs ruah opt. Install it once:</span>
          <CopyCommand command={install} runnable className="w-full max-w-sm" />
        </div>
      ) : null}
      {report && "error" in report ? (
        <p role="alert" className="text-label text-bad">
          ruah opt failed: {report.error.replace(/\.$/, "")}. Try again, or run ruah opt usage in a terminal.
        </p>
      ) : null}
      {report && "topSpenders" in report ? (
        <div className="flex flex-col gap-2 text-label">
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
