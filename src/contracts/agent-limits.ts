// src/contracts/agent-limits.ts — per-agent plan limits (CONTRACTS.md §15):
// GET /api/usage/agents and `ruah app usage limits --json`. One entry per
// coding agent: its plan, one meter per limit window, on-demand spend, what
// the agent's own CLI recorded locally, and Ruah's own estimate from
// usage.jsonl. Nothing here is invented: a source that cannot be read says
// why in `reason`, with the fix in `action`.
import { z } from "zod";

/** The agents Ruah knows how to read limits for, in display order. */
export const LIMIT_AGENT_IDS = ["claude", "cursor", "kiro", "grok", "opencode"] as const;

export const LimitMeterSchema = z.object({
  /** Stable per agent: "five_hour", "seven_day", "included", "auto", "api", "credits", "bonus:welcome"… */
  id: z.string(),
  label: z.string(),
  kind: z.enum(["session", "weekly", "monthly", "credits", "other"]),
  /** 0–100; null when the source gives amounts without a limit (unlimited, unknown). */
  usedPercent: z.number().min(0).max(100).nullable(),
  /** Amounts in `unit` when the source reports them (USD in dollars, not cents). */
  used: z.number().nullable().optional(),
  limit: z.number().nullable().optional(),
  unit: z.enum(["usd", "credits", "requests", "tokens"]).optional(),
  /** ISO time the window resets (or the grant expires); null when unknown. */
  resetsAt: z.string().nullable(),
  /** ISO start of the window when known (drives the "even pace" mark). */
  periodStart: z.string().nullable().optional(),
  /** Short supporting text, e.g. "expires Oct 3" or "Unlimited". */
  detail: z.string().optional(),
});
export type LimitMeter = z.infer<typeof LimitMeterSchema>;

/** Pay-as-you-go spend on top of the plan (Cursor on-demand, Claude extra usage, Kiro overages). */
export const OnDemandSpendSchema = z.object({
  enabled: z.boolean(),
  /** Major units of `currency` (dollars). */
  used: z.number().nonnegative().nullable(),
  /** null = no cap set, or not reported. */
  limit: z.number().nonnegative().nullable(),
  currency: z.string(),
  scope: z.enum(["personal", "team"]).optional(),
  note: z.string().optional(),
});
export type OnDemandSpend = z.infer<typeof OnDemandSpendSchema>;

const Count = z.number().nonnegative();

export const ModelUsageSchema = z.object({
  model: z.string(),
  turns: Count.optional(),
  inputTokens: Count,
  outputTokens: Count,
  cacheReadTokens: Count.optional(),
  cacheWriteTokens: Count.optional(),
  costUsd: z.number().nonnegative().nullable(),
});
export type ModelUsage = z.infer<typeof ModelUsageSchema>;

/** What the agent's own CLI recorded on this machine (grok usage, opencode stats). */
export const LocalUsageSchema = z.object({
  /** The command it came from, e.g. "opencode stats --days 30". */
  source: z.string(),
  /** ISO start of the period; null = all time. */
  since: z.string().nullable(),
  sessions: Count.optional(),
  inputTokens: Count,
  outputTokens: Count,
  cacheReadTokens: Count,
  cacheWriteTokens: Count,
  costUsd: z.number().nonnegative().nullable(),
  /** True when the source rounds (opencode prints "9.6M"). */
  approximate: z.boolean(),
  byModel: z.array(ModelUsageSchema),
});
export type LocalUsage = z.infer<typeof LocalUsageSchema>;

/** Ruah's own numbers from $RUAH_HOME/usage.jsonl: turns run through Ruah only. */
export const UsageEstimateSchema = z.object({
  label: z.literal("estimate"),
  since: z.string(),
  until: z.string(),
  /** Which period: "this weekly window", "this billing period", "last 30 days". */
  basis: z.string(),
  turns: Count,
  inputTokens: Count,
  outputTokens: Count,
  cacheReadTokens: Count,
  cacheWriteTokens: Count,
  /** Sum of agent-reported costs; null when no turn reported one. */
  costUsd: z.number().nonnegative().nullable(),
  /** Turns that reported a cost (the rest count tokens only). */
  costedTurns: Count,
  byModel: z.array(ModelUsageSchema),
});
export type UsageEstimate = z.infer<typeof UsageEstimateSchema>;

export const AgentLimitsStatusSchema = z.enum(["ok", "partial", "not_installed", "not_logged_in", "unsupported", "error"]);
export type AgentLimitsStatus = z.infer<typeof AgentLimitsStatusSchema>;

export const AgentLimitsSchema = z.object({
  agentId: z.string(),
  name: z.string(),
  installed: z.boolean(),
  /** null = not known, or not applicable (OpenCode). */
  loggedIn: z.boolean().nullable(),
  /** Plan / tier as the provider names it ("Max", "Pro+", "Kiro Pro"). */
  plan: z.string().nullable(),
  /**
   * ok: plan meters read · partial: some of it (plan known, meters not) ·
   * unsupported: the agent has no plan limits of its own · error: the source failed.
   */
  status: AgentLimitsStatusSchema,
  /** Why meters are missing or incomplete (set for every status but "ok"). */
  reason: z.string().optional(),
  /** What the user can do, e.g. "Run `kiro-cli login`". */
  action: z.string().optional(),
  meters: z.array(LimitMeterSchema),
  onDemand: OnDemandSpendSchema.optional(),
  local: LocalUsageSchema.optional(),
  estimate: UsageEstimateSchema.optional(),
  /** Where the numbers came from, for the card footer. */
  source: z.string(),
  /** ISO time of this reading. */
  checkedAt: z.string(),
  /** The last good reading is shown because the latest refresh failed (see `reason`). */
  stale: z.boolean().optional(),
  /** The provider's own usage page. */
  dashboardUrl: z.string().optional(),
});
export type AgentLimits = z.infer<typeof AgentLimitsSchema>;

export const AgentLimitsReportSchema = z.object({
  checkedAt: z.string(),
  agents: z.array(AgentLimitsSchema),
});
export type AgentLimitsReport = z.infer<typeof AgentLimitsReportSchema>;
