// What the pages say: the header's Guard button reports a scan in one line (a toast, not text in
// the row).
import { describe, expect, it } from "vitest";
import { guardSummary } from "@/components/engines/GuardCard";

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
