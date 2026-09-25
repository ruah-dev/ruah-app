// Adapted from t3code apps/server/src/provider/Layers/ClaudeProvider.ts (probeClaudeCapabilities, buildClaudeCapabilitiesProbeQueryOptions) (MIT, eff44be43) — see THIRD_PARTY_NOTICES.md
//
// src/usage/claude-probe.ts — plan usage when no live Claude query is around
// (another agent is current, or Claude is not started): a short-lived SDK
// query whose prompt never yields, so the CLI initializes but never sends a
// request to the model; we ask get_usage (skipping the transcript scan) and
// abort. Cost: one CLI start (a few seconds of CPU), zero tokens.
import { query as sdkQuery, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudePlanUsage } from "../acp/bridge.js";
import { resolveClaudeSdkExecutablePath } from "../acp/claude-executable.js";
import { makeClaudeEnvironment } from "../acp/claude-home.js";
import { claudeCode } from "../acp/presets.js";

const INIT_TIMEOUT_MS = 25_000;
const USAGE_TIMEOUT_MS = 10_000;

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function probeClaudePlanUsage(cwd: string, queryImpl: typeof sdkQuery = sdkQuery): Promise<ClaudePlanUsage> {
  const abort = new AbortController();
  const env = makeClaudeEnvironment(claudeCode().env);
  const executable = env.CLAUDE_CODE_EXECUTABLE;
  const q = queryImpl({
    // Never yields: no user message reaches the CLI, so no model request is made.
    prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
      await waitForAbort(abort.signal);
    })(),
    options: {
      cwd,
      persistSession: false,
      abortController: abort,
      ...(executable !== undefined && executable.length > 0 ? { pathToClaudeCodeExecutable: resolveClaudeSdkExecutablePath(executable, env) } : {}),
      // User settings only (login helpers, env); no project hooks/MCP/plugins.
      settingSources: ["user"],
      settings: { disableAllHooks: true },
      allowedTools: [],
      mcpServers: {},
      strictMcpConfig: true,
      env: {
        ...env,
        ENABLE_CLAUDEAI_MCP_SERVERS: "false",
        CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
        CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
      },
      stderr: () => {},
    },
  });
  try {
    await withTimeout(q.initializationResult(), INIT_TIMEOUT_MS, "Claude initialization");
    const response = await withTimeout(
      q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      USAGE_TIMEOUT_MS,
      "Claude get_usage",
    );
    return {
      rate_limits_available: response.rate_limits_available,
      rate_limits: response.rate_limits as Record<string, unknown> | null,
      ...(response.subscription_type !== undefined ? { subscription_type: response.subscription_type } : {}),
    };
  } finally {
    if (!abort.signal.aborted) abort.abort();
    try {
      q.close();
    } catch {
      // already gone
    }
  }
}
