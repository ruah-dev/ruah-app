// The Extensions page's pure logic: argument splitting for the MCP command form (no shell is
// ever involved, it only builds the args array), display of commands, search, per-agent switch
// state, and when turning an agent on must ask for approval first.
import { describe, expect, test } from "vitest";
import {
  agentSwitch,
  commandLine,
  groupByCategory,
  matchesQuery,
  needsApproval,
  splitArgs,
  splitNames,
  type ExtensionView,
} from "../src/lib/extensions";

function view(partial: Partial<ExtensionView>): ExtensionView {
  const support = { delivery: "session" as const, note: "per session" };
  return {
    id: "tiny",
    kind: "mcp",
    name: "Tiny",
    source: { type: "inline" },
    enabledFor: [],
    addedAt: "2026-09-25T00:00:00Z",
    scope: "global",
    status: "ready",
    what: { servers: [{ name: "tiny", transport: "stdio", command: "node", args: ["tiny.mjs"], env: [] }], hooks: [], files: [], launcher: false },
    secrets: [],
    support: { claude: support, cursor: support, grok: support, kiro: support, opencode: support },
    ...partial,
  };
}

describe("extensions view logic", () => {
  test("splitArgs honours quotes and escapes without a shell", () => {
    expect(splitArgs(`-y @modelcontextprotocol/server-filesystem "\${project}"`)).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "${project}"]);
    expect(splitArgs(`--name 'two words' a\\ b ""`)).toEqual(["--name", "two words", "a b", ""]);
    expect(splitArgs("  ")).toEqual([]);
    expect(splitArgs("; rm -rf ~")).toEqual([";", "rm", "-rf", "~"]);
  });

  test("names and command lines", () => {
    expect(splitNames("API_TOKEN, OTHER  API_TOKEN")).toEqual(["API_TOKEN", "OTHER"]);
    expect(commandLine("npx", ["-y", "@playwright/mcp@latest", "two words", "it's"])).toBe(`npx -y @playwright/mcp@latest 'two words' 'it'\\''s'`);
  });

  test("search matches id, name, description and kind", () => {
    expect(matchesQuery({ id: "github", name: "GitHub", kind: "mcp" }, "git")).toBe(true);
    expect(matchesQuery({ id: "x", name: "X", kind: "mcp" }, "MCP server")).toBe(true);
    expect(matchesQuery({ id: "x", name: "X", description: "browser automation", kind: "mcp" }, "browser")).toBe(true);
    expect(matchesQuery({ id: "x", name: "X", kind: "skill" }, "figma")).toBe(false);
  });

  test("per-agent switches and approval", () => {
    const v = view({ enabledFor: ["claude"], support: { ...view({}).support, grok: { delivery: "none", note: "Grok reads AGENTS.md" }, kiro: { delivery: "install", note: "install" } } });
    expect(agentSwitch(v, "claude")).toMatchObject({ on: true, disabled: false, hint: null });
    expect(agentSwitch(v, "grok")).toMatchObject({ on: false, disabled: true, hint: "n/a" });
    expect(agentSwitch(v, "kiro")).toMatchObject({ disabled: false, hint: "install only" });
    expect(agentSwitch(view({ status: "missing" }), "claude").disabled).toBe(true);

    expect(needsApproval(view({}))).toBe(true); // runs a command, never enabled
    expect(needsApproval(view({ enabledFor: ["claude"] }))).toBe(false); // already approved
    expect(needsApproval(view({ enabledFor: ["claude"], status: "review" }))).toBe(true); // changed since
    expect(needsApproval(view({ what: { servers: [{ name: "r", transport: "http", url: "https://x", env: [] }], hooks: [], files: [], launcher: false } }))).toBe(false);
  });

  test("catalog groups keep their order", () => {
    const f = (id: string, category: string) => ({ id, category, kind: "mcp" as const, name: id, description: "" });
    expect(groupByCategory([f("a", "Design"), f("b", "Core"), f("c", "Design")]).map((g) => [g.category, g.items.map((i) => i.id)])).toEqual([
      ["Design", ["a", "c"]],
      ["Core", ["b"]],
    ]);
  });
});
