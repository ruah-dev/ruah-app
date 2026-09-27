// A staged app update restarts Ruah by itself only while the user is away and nothing would be
// lost; otherwise it is offered (lib/app-update.ts, components/shell/useAppUpdate.tsx).
import { describe, expect, it } from "vitest";
import { describeUpdate, restartDecision } from "../src/lib/app-update";

describe("app update", () => {
  it("restarts by itself only when ready, auto, away and idle", () => {
    expect(restartDecision({ phase: "ready", auto: true, away: true, busy: false })).toBe("restart");
    expect(restartDecision({ phase: "ready", auto: true, away: false, busy: false })).toBe("prompt");
    expect(restartDecision({ phase: "ready", auto: true, away: true, busy: true })).toBe("prompt");
    expect(restartDecision({ phase: "ready", auto: false, away: true, busy: false })).toBe("prompt");
    expect(restartDecision({ phase: "building", auto: true, away: true, busy: false })).toBe("none");
  });

  it("describes the update", () => {
    expect(describeUpdate({ behind: 3, subject: "fix(map): x" })).toBe("3 new commits · fix(map): x");
    expect(describeUpdate({ behind: 1 })).toBe("1 new commit");
    expect(describeUpdate({ latest: "abcdef123456" })).toBe("abcdef1");
  });
});
