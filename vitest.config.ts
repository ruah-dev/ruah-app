import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    // Short disconnect grace so tests of §2.2 rule 6 run fast (default 5 s).
    env: { RUAH_DISCONNECT_GRACE_MS: "200" },
  },
});
