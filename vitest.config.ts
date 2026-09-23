import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Pure viewer modules (ui/src/lib, canvas geometry) are tested here too; they import via "@/".
  resolve: { alias: { "@": fileURLToPath(new URL("./ui/src", import.meta.url)) } },
  test: {
    include: ["test/**/*.test.ts", "ui/test/**/*.test.ts"],
    testTimeout: 30_000,
    // Short disconnect grace so tests of §2.2 rule 6 run fast (default 5 s).
    env: { RUAH_DISCONNECT_GRACE_MS: "200" },
  },
});
