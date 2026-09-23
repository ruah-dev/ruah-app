// src/contracts/usage.ts — response shapes of the usage endpoints
// (CONTRACTS.md §2.3: GET /api/usage/summary, GET /api/usage/limits).
import { z } from "zod";

export const USAGE_RANGES = ["24h", "7d", "30d"] as const;
export const UsageRangeSchema = z.enum(USAGE_RANGES);
export type UsageRange = z.infer<typeof UsageRangeSchema>;

const Tokens = z.number().int().nonnegative();
const Cost = z.number().nonnegative().nullable();

export const UsageSummarySchema = z.object({
  range: UsageRangeSchema,
  totals: z.object({
    inputTokens: Tokens,
    outputTokens: Tokens,
    cacheReadTokens: Tokens,
    cacheWriteTokens: Tokens,
    costUsd: Cost,
    turns: Tokens,
  }),
  /** `t` = ISO start of the bucket: hourly for 24h, daily otherwise. */
  series: z.array(z.object({
    t: z.string(),
    agentId: z.string(),
    model: z.string(),
    inputTokens: Tokens,
    outputTokens: Tokens,
    costUsd: Cost,
  })),
  byModel: z.array(z.object({
    agentId: z.string(),
    model: z.string(),
    turns: Tokens,
    inputTokens: Tokens,
    outputTokens: Tokens,
    costUsd: Cost,
  })),
});
export type UsageSummary = z.infer<typeof UsageSummarySchema>;

export const UsageWindowSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["session", "weekly", "other"]),
  usedPercent: z.number().min(0).max(100).nullable(),
  resetsAt: z.string().nullable(),
});
export type UsageWindow = z.infer<typeof UsageWindowSchema>;

export const UsageLimitsSchema = z.object({
  providers: z.array(z.object({
    agentId: z.string(),
    name: z.string(),
    status: z.enum(["available", "unavailable", "unknown"]),
    windows: z.array(UsageWindowSchema),
    note: z.string().optional(),
  })),
});
export type UsageLimits = z.infer<typeof UsageLimitsSchema>;
export type ProviderLimits = UsageLimits["providers"][number];
