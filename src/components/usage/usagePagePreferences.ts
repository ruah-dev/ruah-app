// Adapted from t3code apps/web/src/components/usage/usagePagePreferences.ts (MIT).
import type { UsageRange } from "@/lib/usage";

const STORAGE_KEY = "ruah.usage-page-preferences.v1";

export type UsageMetric = "cost" | "tokens" | "limits";
export interface UsagePagePreferences {
  metric: UsageMetric;
  range: UsageRange;
}

// Cost is what the page is for until the daemon reports subscription limits; the last picked
// tab sticks after that.
const DEFAULTS: UsagePagePreferences = { metric: "tokens", range: "7d" };

export function readUsagePagePreferences(): UsagePagePreferences {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw) as Partial<UsagePagePreferences>;
    return {
      metric: p.metric === "cost" || p.metric === "tokens" || p.metric === "limits" ? p.metric : DEFAULTS.metric,
      range: p.range === "24h" || p.range === "7d" || p.range === "30d" ? p.range : DEFAULTS.range,
    };
  } catch {
    return DEFAULTS;
  }
}

export function saveUsagePagePreferences(p: UsagePagePreferences) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}
