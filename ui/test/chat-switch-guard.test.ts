// Regression: clicking another chat in the recent-chats strip (or New chat) while the agent was
// working — even waiting for a permission — cancelled the turn without a word, although a project
// switch keeps turns running. The shell now asks first; this is the rule it asks on.
import { describe, expect, it } from "vitest";
import { activeTurnRunning } from "@/components/projects/useProjectActions";

describe("activeTurnRunning", () => {
  it("is true while the chat in front has a turn without a stop reason", () => {
    expect(activeTurnRunning({ turns: [] })).toBe(false);
    expect(activeTurnRunning({ turns: [{ stopReason: "end_turn" }, { stopReason: "cancelled" }] } as never)).toBe(false);
    expect(activeTurnRunning({ turns: [{ stopReason: "end_turn" }, {}] } as never)).toBe(true);
  });
});
