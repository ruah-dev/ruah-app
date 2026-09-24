import { describe, expect, it } from "vitest";
import { badgeFromReport } from "../src/engines/verify.js";
import { usageRecord, type FinishedTurn } from "../src/usage/index.js";
import { summarizeUsage } from "../src/usage/summary.js";
import type { UsageRecord } from "../src/usage/log.js";

describe("badgeFromReport", () => {
  it("never treats unverifiable as pass", () => {
    expect(
      badgeFromReport({
        verdict: "pass-with-unverifiable",
        summary: { pass: true, failed: 0, unverifiable: 1 },
      }),
    ).toBe("unverifiable");
    expect(
      badgeFromReport({
        verdict: "pass",
        summary: { pass: true, failed: 0, unverifiable: 0 },
      }),
    ).toBe("pass");
    expect(
      badgeFromReport({
        verdict: "fail",
        summary: { pass: false, failed: 1, unverifiable: 0 },
      }),
    ).toBe("fail");
  });

  it("maps missing CLI to unverifiable, other errors to error", () => {
    expect(badgeFromReport(null, "ruah verify is not installed")).toBe("unverifiable");
    expect(badgeFromReport(null, "timed out")).toBe("error");
  });
});

describe("usage nodeId", () => {
  it("records nodeId on finished turns and aggregates byNode", async () => {
    const turn: FinishedTurn = {
      repoRoot: "/repo",
      agentId: "claude",
      model: "claude-sonnet",
      turnId: "t1",
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 },
      elapsedMs: 1000,
      nodeId: "repo:api",
    };
    const record = usageRecord(turn, new Date("2026-09-23T12:00:00.000Z"));
    expect(record.nodeId).toBe("repo:api");

    const records: UsageRecord[] = [
      record,
      {
        ...record,
        turnId: "t2",
        nodeId: "repo:api",
        costUsd: 0.02,
        inputTokens: 5,
        outputTokens: 5,
      },
      {
        ...record,
        turnId: "t3",
        nodeId: "repo:web",
        costUsd: 0.05,
      },
    ];
    const summary = await summarizeUsage(records, "7d", Date.parse("2026-09-23T13:00:00.000Z"), [
      { id: "feature", steps: ["repo:api", "repo:web"] },
    ]);
    expect(summary.byNode?.find((n) => n.nodeId === "repo:api")?.turns).toBe(2);
    expect(summary.byWorkflow?.[0]?.workflowId).toBe("feature");
    expect(summary.byWorkflow?.[0]?.turns).toBe(3);
  });
});
