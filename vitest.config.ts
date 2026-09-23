import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Pure viewer modules (ui/src/lib, canvas geometry) are tested here too; they import via "@/".
  resolve: { alias: { "@": fileURLToPath(new URL("./ui/src", import.meta.url)) } },
  test: {
    include: ["test/**/*.test.ts", "ui/test/**/*.test.ts"],
    testTimeout: 30_000,
    // Short disconnect grace so tests of §2.2 rule 6 run fast (default 5 s).
    // RUAH_HOME: tests (and daemons they spawn) never touch the real ~/.ruah —
    // otherwise every run left fixture projects in the user's recent list.
    env: { RUAH_DISCONNECT_GRACE_MS: "200", RUAH_HOME: join(tmpdir(), `ruah-test-home-${process.pid}`) },
  },
});
