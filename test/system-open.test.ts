import { cpSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { makeOpenSystemProject } from "../src/system/open.js";
import { systemRootsFor } from "../src/system/roots.js";

test("opening a system folder builds the system map and resolves repo paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ruah-sys-"));
  cpSync(resolve("test/fixtures/system"), dir, { recursive: true });
  const { store, name } = await makeOpenSystemProject("test", { watch: false })(dir);
  try {
    expect(name).toBe("acme-platform");
    expect(existsSync(join(dir, "architecture.json"))).toBe(true);
    const top = (store.current()?.nodes ?? []).filter((n) => n.parent === undefined).map((n) => n.id);
    expect(top).toEqual(expect.arrayContaining(["web", "invoices-api", "notify-worker", "infra", "postgres"]));
    expect(store.resolvePath?.("invoices-api/src/server.js")?.abs).toBe(join(dir, "invoices-api", "src", "server.js"));
    expect(store.resolvePath?.("unknown/x.js")).toBeNull();
    expect(store.resolvePath?.("invoices-api/../../outside")).toBeNull();
    expect(systemRootsFor(dir)).toContain(join(dir, "web"));
  } finally {
    store.close();
  }
});
