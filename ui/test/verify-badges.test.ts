// Regression (§21.4): verify badges of the previous project stayed on the map for up to one poll
// (4 s) after a project switch, and a poll in flight during the switch could bring them back.
import { describe, expect, test } from "vitest";
import { legacyNoticeFor, verifyAnswerFor, visibleVerifyNodes } from "../src/lib/engines";

const pass = { api: { nodeId: "api", badge: "pass" as const } };

describe("verify badges follow the open project", () => {
  test("a switch hides the old badges at once, and during the switch", () => {
    const state = { root: "/work/client-a", nodes: pass };
    expect(visibleVerifyNodes(state, "/work/client-a")).toEqual(pass);
    expect(visibleVerifyNodes(state, "/work/client-b")).toEqual({});
    expect(visibleVerifyNodes(state, null)).toEqual({});
    expect(visibleVerifyNodes({ root: null, nodes: pass }, "/work/client-a")).toEqual({});
  });

  test("an answer about another project is dropped; older daemons without `root` are taken as asked", () => {
    expect(verifyAnswerFor("/work/client-b", { root: "/work/client-a", nodes: pass })).toBeUndefined();
    expect(verifyAnswerFor("/work/client-a", { root: "/work/client-a/", nodes: pass })).toEqual(pass);
    expect(verifyAnswerFor("/work/client-a", { nodes: pass })).toEqual(pass);
    expect(verifyAnswerFor("/work/client-a", null)).toBeUndefined();
  });
});

describe("what an older Ruah left in the repo (§21.3)", () => {
  test("the placeholder is offered for removal until the user keeps it; leftovers are named", () => {
    const placeholder = { placeholderCriteria: ".ruah/verify.json" };
    expect(legacyNoticeFor("/work/client-a", placeholder, [])).toBe("placeholder");
    expect(legacyNoticeFor("/work/client-a", placeholder, ["/work/client-a/"])).toBeUndefined();
    expect(legacyNoticeFor("/work/client-a", placeholder, ["/work/client-b"])).toBe("placeholder");
    expect(legacyNoticeFor("/work/client-a", { leftover: [".ruah/.cache/verify-nodes.json"] }, [])).toBe("leftover");
    expect(legacyNoticeFor("/work/client-a", undefined, [])).toBeUndefined();
    expect(legacyNoticeFor("/work/client-a", { leftover: [] }, [])).toBeUndefined();
  });
});
