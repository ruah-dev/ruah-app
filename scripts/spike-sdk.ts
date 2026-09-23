// scripts/spike-sdk.ts — live smoke for ClaudeSdkBridge against the local
// Claude Code login. Usage: pnpm tsx scripts/spike-sdk.ts <repo>
// Starts the bridge on <repo>, sends one tiny prompt, prints every bridge
// event, and exits non-zero unless the turn ends with end_turn.
import { resolve } from "node:path";
import { ClaudeSdkBridge } from "../src/acp/claude-sdk-bridge.js";

const repo = resolve(process.argv[2] ?? process.cwd());
const bridge = new ClaudeSdkBridge({
  root: repo,
  preset: { command: "unused", args: [] },
  clientVersion: "spike",
  onStderr: (chunk) => process.stderr.write(`[claude stderr] ${chunk}`),
});

bridge.on((event) => {
  console.log(JSON.stringify(event));
  if (event.type === "permission") {
    // The prompt should not need tools; refuse anything it asks for.
    bridge.answerPermission(event.requestId, { optionId: "reject" });
  }
});

const started = Date.now();
try {
  await bridge.start();
  console.log(`# started in ${Date.now() - started} ms`);
  const turn = bridge.prompt("spike-1", [{ type: "text", text: "Reply with exactly: OK" }]);
  const outcome = await turn.done;
  console.log(`# turn finished in ${Date.now() - started} ms: ${JSON.stringify(outcome)}`);
  process.exitCode = outcome.stopReason === "end_turn" ? 0 : 1;
} catch (cause) {
  console.error("# spike failed:", cause);
  process.exitCode = 1;
} finally {
  await bridge.stop();
}
