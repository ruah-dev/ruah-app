// What the pages say: the header's Guard button reports a scan in one line (a toast, not text in
// the row), and a terminal that couldn't open says what to do next by what went wrong.
import { describe, expect, it } from "vitest";
import { guardSummary } from "@/components/engines/GuardCard";
import { terminalErrorCopy } from "@/components/terminal/error-copy";

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

describe("terminal error next step", () => {
  it("points at Ruah only when the terminal isn't connected to it", () => {
    expect(terminalErrorCopy(new Error("The terminal connection closed."), "closed")).toBe(
      "The terminal connection closed. Check that Ruah is still running, then try again.",
    );
    expect(terminalErrorCopy(new Error("The terminal did not connect."), "connecting")).toMatch(/Ruah is still running/);
  });

  it("a shell or folder error with the daemon up just says to try again", () => {
    expect(terminalErrorCopy(new Error("posix_spawnp failed."), "open")).toBe("posix_spawnp failed. Try again.");
    expect(terminalErrorCopy("cwd /x does not exist", "open")).toBe("cwd /x does not exist. Try again.");
  });

  it("an unavailable terminal carries its own reason", () => {
    expect(terminalErrorCopy(new Error("node-pty is not installed."), "unavailable")).toBe("node-pty is not installed.");
    expect(terminalErrorCopy(new Error(""), "open")).toBe("Unknown error. Try again.");
  });
});
