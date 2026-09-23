// scripts/spike-acp.ts — live smoke of AcpProcessBridge against the real Claude
// ACP adapter (claudeCode() preset), cwd = this repo. Prompts once and prints
// every BridgeEvent with a millisecond timestamp. Bills the logged-in Claude
// account for one short turn.
//   pnpm tsx scripts/spike-acp.ts ["prompt text"]
// Permission requests are rejected automatically; the turn is cancelled after 90 s.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpProcessBridge } from "../src/acp/acp-bridge.js";
import { claudeCode } from "../src/acp/presets.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const promptText = process.argv[2] ?? "Reply with exactly: OK";
const t0 = Date.now();
const stamp = (): string => `+${String(Date.now() - t0).padStart(6)} ms`;

const bridge = new AcpProcessBridge({
  root,
  preset: claudeCode(),
  clientVersion: "0.1.0-spike",
  onStderr: (chunk) => {
    for (const line of chunk.split("\n")) if (line.trim()) console.log(`${stamp()} stderr ${line}`);
  },
});

bridge.on((event) => {
  console.log(`${stamp()} ${JSON.stringify(event)}`);
  if (event.type === "permission") {
    const reject = event.options.find((o) => o.kind === "reject_once") ?? event.options[0];
    if (reject) bridge.answerPermission(event.requestId, { optionId: reject.optionId });
  }
});

try {
  await bridge.start();
  console.log(`${stamp()} started; prompting: ${promptText}`);
  const handle = bridge.prompt("spike-1", [{ type: "text", text: promptText }]);
  const timer = setTimeout(() => void bridge.cancel("spike-1"), 90_000);
  const result = await handle.done;
  clearTimeout(timer);
  console.log(`${stamp()} done ${JSON.stringify(result)}`);
} catch (err) {
  console.log(`${stamp()} failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await bridge.stop();
}
