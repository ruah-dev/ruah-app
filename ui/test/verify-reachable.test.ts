// Regression: runVerify() and syncVerify() had no caller in the viewer, while the daemon's
// "unverifiable" detail pointed users at a "Sync criteria" action that did not exist. The element
// inspector now has Verify, and the detail names the real way to create criteria.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("verify from the viewer", () => {
  it("the element inspector runs verify", () => {
    const panel = read("../src/components/engines/NodeEnginesPanel.tsx");
    expect(panel).toMatch(/runVerify\(nodeId\)/);
  });
  it("no viewer text or daemon hint points at a missing Sync criteria action", () => {
    expect(read("../../src/engines/verify.ts")).not.toMatch(/Sync criteria writes/);
    expect(read("../src/lib/engines.ts")).not.toMatch(/export async function syncVerify/);
  });
});
