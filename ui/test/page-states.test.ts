// What the pages say when there is nothing to show yet: the Tasks setup state follows the daemon's
// hint, and the header's Guard button reports a scan in one line (a toast, not text in the row).
import { describe, expect, it } from "vitest";
import { notInitializedCopy } from "@/components/orchestration/TasksPage";
import { guardSummary } from "@/components/engines/GuardCard";

describe("Tasks setup state", () => {
  it("offers the install command when ruah is missing", () => {
    const c = notInitializedCopy("npm i -g @ruah-dev/cli");
    expect(c.title).toBe("ruah isn't installed");
    expect(c.command).toBe("npm i -g @ruah-dev/cli");
    expect(c.body).toMatch(/Install it once, then check again/);
  });

  it("asks for a project when none is open (no command to run)", () => {
    const c = notInitializedCopy("Open a project to use ruah tasks.");
    expect(c.title).toBe("Open a project first");
    expect(c.command).toBeNull();
  });

  it("defaults to ruah init in the repo root", () => {
    expect(notInitializedCopy(undefined)).toMatchObject({ title: "ruah isn't set up in this repository", command: "ruah init" });
    expect(notInitializedCopy("  ")).toMatchObject({ command: "ruah init" });
    expect(notInitializedCopy("ruah init --force").command).toBe("ruah init --force");
  });
});

describe("Guard result line", () => {
  it("counts findings and files, with the audit entries when there are some", () => {
    expect(guardSummary({ summary: { total: 0, filesScanned: 12, failed: false } } as never, { entries: [], count: 3 } as never)).toEqual({
      ok: true,
      text: "0 findings in 12 files · 3 audit entries.",
    });
    expect(guardSummary({ summary: { total: 1, filesScanned: 1, failed: true } } as never, null)).toEqual({
      ok: false,
      text: "1 finding in 1 file — review before sharing.",
    });
  });

  it("says what failed", () => {
    expect(guardSummary({ error: "guard exited 2" }, null)).toEqual({ ok: false, text: "Guard couldn't scan: guard exited 2" });
  });
});
