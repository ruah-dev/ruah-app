// Regression: three negative answers did different things. Home's and the card's "Reject" declined
// one tool call, but the bell's "Deny" and the card's Esc sent `cancelled`, which stops the whole
// turn (Claude: interrupt) — a stray second Esc killed the agent's work. Every reject now sends
// the reject_once option; Esc answers nothing.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");

describe("rejecting a permission", () => {
  it("picks the reject-once option (never the turn-stopping cancel)", async () => {
    const { rejectOption } = await import("../src/lib/daemon");
    const options = [
      { optionId: "allow", name: "Allow", kind: "allow_once" as const },
      { optionId: "always-no", name: "Never", kind: "reject_always" as const },
      { optionId: "no", name: "Reject", kind: "reject_once" as const },
    ];
    expect(rejectOption(options)?.optionId).toBe("no");
    expect(rejectOption(options.slice(0, 2))?.optionId).toBe("always-no");
    expect(rejectOption(options.slice(0, 1))).toBeUndefined();
  });

  it("the bell and the permission card never send cancelled", () => {
    for (const file of ["components/shell/TopBar.tsx", "components/agent/PermissionCard.tsx"]) {
      expect(read(file), file).not.toMatch(/answerPermission\([^)]*"cancel"\)/);
    }
    expect(read("components/shell/TopBar.tsx")).toMatch(/rejectPermissionAnywhere\(/);
    expect(read("components/agent/PermissionCard.tsx")).not.toMatch(/"Escape"/);
  });
});
