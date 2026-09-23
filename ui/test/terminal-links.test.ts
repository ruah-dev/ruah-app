import { describe, expect, test } from "vitest";
import { findPaths, projectPathOf, safeExternalUrl } from "@/lib/terminal-links";

describe("terminal file links", () => {
  test("finds paths with line and column, ignores words, versions and URLs", () => {
    const line = "src/app.ts:12:5 error, see ./lib/util.ts and ../x/y.go(3,4); v1.2.3 https://example.com/a/b.js done";
    const found = findPaths(line).map((m) => [m.path, m.line, m.column]);
    expect(found).toEqual([
      ["src/app.ts", 12, 5],
      ["./lib/util.ts", undefined, undefined],
      ["../x/y.go", 3, 4],
    ]);
    expect(findPaths("hello world, nothing to see")).toEqual([]);
    expect(findPaths("package.json")).toEqual([]); // no folder part: too ambiguous to link
  });

  test("absolute paths and folders", () => {
    expect(findPaths("at /repo/src/index.ts:3").map((m) => m.path)).toEqual(["/repo/src/index.ts"]);
    expect(findPaths("cd ./src/components/").map((m) => m.path)).toEqual(["./src/components"]);
  });

  test("offsets point at the printed text", () => {
    const line = "  --> src/main.rs:10:1";
    const [m] = findPaths(line);
    expect(line.slice(m!.index, m!.index + m!.text.length)).toBe("src/main.rs:10:1");
  });
});

describe("project paths", () => {
  test("relative to the terminal folder, inside the project only", () => {
    expect(projectPathOf("button.tsx", "/repo/src/ui", "/repo")).toBe("src/ui/button.tsx");
    expect(projectPathOf("../lib/a.ts", "/repo/src/ui", "/repo")).toBe("src/lib/a.ts");
    expect(projectPathOf("/repo/README.md", "/repo/src", "/repo")).toBe("README.md");
    expect(projectPathOf("/etc/hosts", "/repo", "/repo")).toBeNull();
    expect(projectPathOf("../../outside.ts", "/repo/src", "/repo")).toBeNull();
    expect(projectPathOf("/repository/x.ts", "/repo", "/repo")).toBeNull(); // prefix, not parent
    expect(projectPathOf("~/repo/a.ts", "/x", "/Users/me/repo", "/Users/me")).toBe("a.ts");
  });
});

describe("external URLs", () => {
  test("only http(s) leaves the app", () => {
    expect(safeExternalUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(safeExternalUrl("http://localhost:3000")).toBe("http://localhost:3000/");
    expect(safeExternalUrl("file:///etc/passwd")).toBeNull();
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("vscode://open")).toBeNull();
    expect(safeExternalUrl("not a url")).toBeNull();
  });
});
