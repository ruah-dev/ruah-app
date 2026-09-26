// src/engines/eval.ts — run one prompt across supported agent CLIs via ruah-eval.
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveBin } from "../integrations/exec.js";
import { engineInstallCommand, resolveEngineInvocation, runEngineJson, type EngineCliDeps } from "./cli.js";

export interface EvalExecutorSpec {
  name: string;
  type: "cli";
  command: string;
  args?: string[];
}

const EXECUTOR_CANDIDATES: Array<{ name: string; bins: string[]; args: string[] }> = [
  { name: "claude-code", bins: ["claude"], args: ["-p", "{prompt}"] },
  { name: "cursor-agent", bins: ["cursor-agent", "agent"], args: ["-p", "{prompt}"] },
  { name: "grok-build", bins: ["grok"], args: ["-p", "{prompt}"] },
  { name: "kiro-cli", bins: ["kiro-cli", "kiro"], args: ["-p", "{prompt}"] },
  { name: "opencode", bins: ["opencode"], args: ["run", "{prompt}"] },
];

export function detectEvalExecutors(env: NodeJS.ProcessEnv = process.env): EvalExecutorSpec[] {
  const out: EvalExecutorSpec[] = [];
  for (const candidate of EXECUTOR_CANDIDATES) {
    const bin = candidate.bins.map((b) => resolveBin(b, env)).find((b) => b !== undefined);
    if (!bin) continue;
    out.push({ name: candidate.name, type: "cli", command: bin, args: candidate.args });
  }
  return out;
}

export interface EvalRunRequest {
  root: string;
  nodeId: string;
  prompt: string;
  criteria?: Array<Record<string, unknown>>;
  deps?: EngineCliDeps;
  /** Where the spec and results go: $RUAH_HOME/projects/<id>/cache/evals — never the repo (§20.3). */
  outDir: string;
}

export async function runEvalOnNode(req: EvalRunRequest): Promise<
  | { ok: true; resultsPath: string; scorecard: unknown; executors: string[] }
  | { ok: false; status: number; error: string }
> {
  const executors = detectEvalExecutors(req.deps?.env);
  if (executors.length === 0) {
    return {
      ok: false,
      status: 424,
      error:
        "No supported agent CLIs found (claude, cursor-agent, grok, kiro-cli, opencode). Install at least one to run eval.",
    };
  }

  const criteria =
    req.criteria ??
    ([
      {
        id: "output-nonempty",
        description: "Executor produced output",
        check: { type: "output_regex", pattern: ".+" },
      },
      {
        id: "human-review",
        description: "Quality of the answer for this node",
        check: { type: "unverifiable", reason: "Judged by the operator from the scorecard" },
      },
    ] as Array<Record<string, unknown>>);

  if (resolveEngineInvocation("eval", req.deps ?? {}) === null) {
    return { ok: false, status: 424, error: `ruah eval is not installed. ${engineInstallCommand("eval")}` };
  }
  const dir = req.outDir;
  fs.mkdirSync(dir, { recursive: true });
  const safeId = req.nodeId.replace(/[^a-zA-Z0-9:_-]/g, "_");
  const specPath = path.join(dir, `node-${safeId}.json`);
  const resultsPath = path.join(dir, `results-${safeId}-${Date.now()}.json`);
  const spec = {
    name: `node-${safeId}`,
    task: { prompt: req.prompt },
    executors,
    criteria,
    runs: 1,
  };
  fs.writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");

  const run = await runEngineJson<unknown>("eval", ["run", specPath, "--out", resultsPath], {
    cwd: req.root,
    ...(req.deps !== undefined ? { deps: req.deps } : {}),
    timeoutMs: 600_000,
  });
  if (!run.ok) return { ok: false, status: run.status, error: run.error };

  const score = await runEngineJson<unknown>("eval", ["scorecard", resultsPath], {
    cwd: req.root,
    ...(req.deps !== undefined ? { deps: req.deps } : {}),
  });
  if (!score.ok) {
    return {
      ok: true,
      resultsPath,
      scorecard: { error: score.error, note: "Eval finished but scorecard failed" },
      executors: executors.map((e) => e.name),
    };
  }
  return {
    ok: true,
    resultsPath,
    scorecard: score.data,
    executors: executors.map((e) => e.name),
  };
}
