// Inspector actions: eval scorecard + convert OpenAPI via engine CLIs.
import { useEffect, useState } from "react";
import { detectConv, runConv, runEval } from "@/lib/engines";
import { GuardCard } from "@/components/engines/GuardCard";
import { Button } from "@/components/ui/button";

export function NodeEnginesPanel({ nodeId, defaultPrompt }: { nodeId: string; defaultPrompt?: string }) {
  const [prompt, setPrompt] = useState(defaultPrompt ?? "");
  const [evalBusy, setEvalBusy] = useState(false);
  const [evalResult, setEvalResult] = useState<unknown>(null);
  const [specs, setSpecs] = useState<Array<{ path: string; kind: string }>>([]);
  const [convBusy, setConvBusy] = useState(false);
  const [convResult, setConvResult] = useState<unknown>(null);

  useEffect(() => {
    setPrompt(defaultPrompt ?? "");
    setEvalResult(null);
    setConvResult(null);
    void detectConv(nodeId)
      .then((r) => setSpecs(r.specs ?? []))
      .catch(() => setSpecs([]));
  }, [nodeId, defaultPrompt]);

  return (
    <div className="flex flex-col gap-4 border-t border-hairline pt-3">
      <div className="flex flex-col gap-2">
        <h3 className="text-label font-medium text-foreground">Eval scorecard</h3>
        <p className="text-caption text-muted-foreground">
          Runs one prompt across installed agent CLIs via <code>ruah eval</code>. Unverifiable criteria never count as pass.
        </p>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          placeholder="Prompt to run on this element…"
          className="w-full rounded-md border border-hairline bg-surface-3 px-2 py-1.5 text-label text-foreground"
        />
        <Button
          size="sm"
          disabled={evalBusy || prompt.trim().length === 0}
          onClick={() => {
            setEvalBusy(true);
            void runEval(nodeId, prompt.trim())
              .then(setEvalResult)
              .finally(() => setEvalBusy(false));
          }}
        >
          {evalBusy ? "Running eval…" : "Run eval"}
        </Button>
        {evalResult !== null ? (
          <pre className="max-h-48 overflow-auto rounded-md bg-surface-3 p-2 text-micro leading-relaxed text-muted-foreground">
            {JSON.stringify(evalResult, null, 2)}
          </pre>
        ) : null}
      </div>

      {specs.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-label font-medium text-foreground">Convert API spec</h3>
          <p className="text-caption text-muted-foreground">Detected specs on this element — runs <code>ruah conv</code>.</p>
          <ul className="flex flex-col gap-2">
            {specs.map((s) => (
              <li key={s.path} className="flex flex-wrap items-center gap-2 text-label">
                <span className="font-mono text-caption">{s.path}</span>
                <span className="text-muted-foreground">({s.kind})</span>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={convBusy}
                  onClick={() => {
                    setConvBusy(true);
                    void runConv(nodeId, s.path, "inspect")
                      .then(setConvResult)
                      .finally(() => setConvBusy(false));
                  }}
                >
                  Inspect
                </Button>
                <Button
                  size="sm"
                  disabled={convBusy}
                  onClick={() => {
                    setConvBusy(true);
                    void runConv(nodeId, s.path, "generate")
                      .then(setConvResult)
                      .finally(() => setConvBusy(false));
                  }}
                >
                  Generate
                </Button>
              </li>
            ))}
          </ul>
          {convResult !== null ? (
            <pre className="max-h-48 overflow-auto rounded-md bg-surface-3 p-2 text-micro leading-relaxed text-muted-foreground">
              {JSON.stringify(convResult, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}
      <GuardCard />
    </div>
  );
}
