// src/usage/limits/index.ts — per-agent plan limits as a standalone library
// (CONTRACTS §15): one provider per coding agent, a caching service, and the
// text rendering the CLI prints. No daemon needed: `ruah app usage limits`
// builds the same service with a direct Claude probe.
import { claudeProvider, type ClaudePlanSource } from "./claude.js";
import { cursorProvider } from "./cursor.js";
import { grokProvider } from "./grok.js";
import { kiroProvider } from "./kiro.js";
import { opencodeProvider } from "./opencode.js";
import type { LimitsProvider } from "./common.js";

export { AgentLimitsService, UnknownAgentError, type AgentLimitsServiceOptions } from "./service.js";
export { defaultContext, type LimitsContext, type LimitsProvider, type FetchLike } from "./common.js";
export { claudeProvider, claudeLimitsFromReading, probeSource, type ClaudePlanReading, type ClaudePlanSource } from "./claude.js";
export { cursorProvider, parseCursorAbout, parseCursorUsage, parseCursorAuthRows, cursorSessionCookie, cursorStateDbPath } from "./cursor.js";
export { kiroProvider, parseKiroUsage, parseKiroWhoami, parseKiroUsageText, kiroAcpUsage } from "./kiro.js";
export { grokProvider, parseGrokLogin, parseGrokSessions, recentGrokSessions, GrokUsageTotals } from "./grok.js";
export { opencodeProvider, parseOpencodeStats } from "./opencode.js";
export { buildEstimates, estimatePeriod, limitsAgentId } from "./estimate.js";
export { formatLimitsReport } from "./format.js";

/** Every agent's provider, in display order; Claude reads from `claude`. */
export function defaultProviders(claude: ClaudePlanSource, options: { claudeTtlMs?: number } = {}): LimitsProvider[] {
  return [claudeProvider(claude, options.claudeTtlMs ?? 0), cursorProvider(), kiroProvider(), grokProvider(), opencodeProvider()];
}
