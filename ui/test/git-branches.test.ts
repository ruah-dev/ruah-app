// lib/git-branches.ts (CONTRACTS §24): the switch toast's map summary, the chip's details, the
// branch filter, the new-branch name check and when switching is blocked.
import { describe, expect, it } from "vitest";
import {
  aheadBehind,
  branchNameProblem,
  branchSummary,
  chipLabel,
  filterBranches,
  gitChipLines,
  switchBlocker,
  switchToast,
  type ArchitectureDiff,
  type BranchList,
  type SwitchResult,
} from "@/lib/git-branches";

const empty: ArchitectureDiff = { added: [], removed: [], changed: [], edges: { added: [], removed: [] }, workflows: { added: [], removed: [] } };
const el = (id: string) => ({ id, name: id, type: "service" });

describe("branchSummary", () => {
  it("counts elements added, removed and changed", () => {
    expect(branchSummary({ ...empty, added: [el("a"), el("b"), el("c")], removed: [el("d")], changed: [{ id: "e", name: "e", fields: ["tech"] }, { id: "f", name: "f", fields: ["name"] }] })).toBe(
      "+3 elements, −1, 2 changed",
    );
    expect(branchSummary({ ...empty, added: [el("a")] })).toBe("+1 element");
    expect(branchSummary({ ...empty, removed: [el("a"), el("b")] })).toBe("−2 elements");
    expect(branchSummary({ ...empty, changed: [{ id: "e", name: "e", fields: ["tech"] }] })).toBe("1 changed");
  });

  it("falls back to links and workflows, then to the same map", () => {
    expect(branchSummary({ ...empty, edges: { added: [{ from: "a", to: "b" }], removed: [] } })).toBe("1 link changed");
    expect(branchSummary({ ...empty, workflows: { added: [], removed: [{ id: "w", name: "W" }, { id: "v", name: "V" }] } })).toBe("2 workflows changed");
    expect(branchSummary(empty)).toBe("same map");
  });
});

describe("switchToast", () => {
  const base: SwitchResult = { ok: true, branch: "feature-x", previous: "main", created: false, carried: 0, architecture: "tracked", diff: { ...empty, added: [el("q")] } };
  it("names the branch and what else happened", () => {
    expect(switchToast(base)).toEqual({ title: "feature-x: +1 element", description: "" });
    expect(switchToast({ ...base, carried: 2, architecture: "generated", created: true }).description).toBe(
      "no map on this branch — scanned one · carried 2 changed files · new branch",
    );
    expect(switchToast({ ...base, architecture: "rescanned", architectureError: "bad json" }).description).toMatch(/rescanned.*bad json/);
  });
});

describe("chip", () => {
  const git = {
    available: true as const,
    branch: "main",
    head: "abc1234def",
    upstream: "origin/main",
    ahead: 2,
    behind: 1,
    dirty: 7,
    dirtyPaths: ["a.ts", "b.ts"],
    lastCommit: { hash: "abc1234", subject: "Fix it", author: "Me", at: new Date(Date.now() - 3 * 3_600_000).toISOString() },
  };
  it("labels the branch, or the short sha when detached", () => {
    expect(chipLabel(git)).toBe("main");
    expect(chipLabel({ ...git, branch: null })).toBe("abc1234");
    expect(chipLabel({ ...git, branch: null, head: null })).toBe("detached");
  });
  it("keeps the tooltip details", () => {
    expect(gitChipLines(git)).toEqual([
      "On main · tracking origin/main",
      "2 commits to push",
      "1 commit to pull",
      "7 uncommitted files: a.ts, b.ts, …",
      "Last commit: Fix it (3h)",
    ]);
    expect(gitChipLines({ ...git, branch: null, ahead: null, behind: null, dirty: 0, lastCommit: null })).toEqual(["Detached at abc1234", "Working tree clean"]);
  });
  it("shows ahead / behind", () => {
    expect(aheadBehind({ ahead: 2, behind: 1 })).toBe("↑2 ↓1");
    expect(aheadBehind({})).toBe("");
  });
});

describe("filterBranches", () => {
  const commit = (subject: string) => ({ sha: "abc", subject, date: "2026-09-01T00:00:00Z" });
  const list: Pick<BranchList, "local" | "remote"> = {
    local: [
      { name: "main", current: true, lastCommit: commit("Release") },
      { name: "feature/login", current: false, lastCommit: commit("Add OAuth") },
    ],
    remote: [
      { name: "origin/main", remote: "origin", branch: "main", hasLocal: true, lastCommit: commit("Release") },
      { name: "origin/spike", remote: "origin", branch: "spike", hasLocal: false, lastCommit: commit("Try queues") },
    ],
  };
  it("keeps remote-only branches and matches names or commit subjects", () => {
    expect(filterBranches(list, "").remote.map((r) => r.name)).toEqual(["origin/spike"]);
    expect(filterBranches(list, "LOGIN").local.map((b) => b.name)).toEqual(["feature/login"]);
    expect(filterBranches(list, "oauth").local.map((b) => b.name)).toEqual(["feature/login"]);
    expect(filterBranches(list, "queues")).toEqual({ local: [], remote: [list.remote[1]] });
  });
});

describe("branchNameProblem", () => {
  it("accepts ordinary names and explains the rest", () => {
    expect(branchNameProblem("feature/new-map_2")).toBeNull();
    expect(branchNameProblem("")).toBe("Type a name");
    expect(branchNameProblem("-f")).toMatch(/-/);
    expect(branchNameProblem("a b")).toMatch(/spaces/);
    expect(branchNameProblem("a..b")).toMatch(/\.\./);
    expect(branchNameProblem("@{-1}")).toMatch(/@\{/);
    expect(branchNameProblem("x.lock")).toMatch(/lock/);
    expect(branchNameProblem("x/.hidden")).toMatch(/start with \./);
    expect(branchNameProblem("a//b")).toMatch(/Slashes/);
    expect(branchNameProblem("HEAD")).toMatch(/reserved/);
    expect(branchNameProblem("main", ["main"])).toMatch(/exists/);
  });
});

describe("switchBlocker", () => {
  it("blocks while an agent works, for systems and in the sample", () => {
    expect(switchBlocker({ turnRunning: false, kind: "repo", sample: false })).toBeNull();
    expect(switchBlocker({ turnRunning: true, kind: "repo", sample: false })).toMatch(/agent is working/);
    expect(switchBlocker({ turnRunning: false, kind: "system", sample: false })).toMatch(/system view/);
    expect(switchBlocker({ turnRunning: false, kind: "repo", sample: true })).toMatch(/Connect Ruah/);
  });
});
