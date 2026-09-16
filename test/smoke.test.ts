import { expect, test } from "vitest";

test("runs the bootstrap test harness", () => {
  expect(process.versions.node.split(".").map(Number)[0]).toBeGreaterThanOrEqual(22);
});
