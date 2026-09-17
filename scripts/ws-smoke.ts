// scripts/ws-smoke.ts — drives the CONTRACTS.md §2.4 sequence against a
// running daemon (start it with `archmap serve --mock <dir> --port <port>`).
// Prints each frame as one line of JSON. Exits 0 when the full scripted turn
// completes end-to-end, 1 otherwise.
//
// Usage: pnpm exec tsx scripts/ws-smoke.ts [ws://127.0.0.1:4177/ws]
import WebSocket from "ws";

const url = process.argv[2] ?? "ws://127.0.0.1:4177/ws";
const ws = new WebSocket(url);
const seen: unknown[] = [];
let promptSent = false;
let permissionAnswered = false;

function done(fail: string | null): never {
  if (fail !== null) {
    console.error(`SMOKE FAIL: ${fail}`);
    process.exit(1);
  }
  console.log("SMOKE OK");
  process.exit(0);
}

const timeout = setTimeout(() => done("timed out waiting for turn.finished"), 20_000);

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "hello", protocol: 1, client: "ws-smoke/0.1.0" }));
});

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
  seen.push(msg);
  console.log(JSON.stringify(msg));

  if (msg.type === "architecture" && !promptSent) {
    promptSent = true;
    ws.send(JSON.stringify({ type: "focus.set", nodeId: "api" }));
    ws.send(
      JSON.stringify({
        type: "prompt",
        turnId: "3f1c1c2e-8a7b-4a53-9a1a-5d1c0f0b7e11",
        nodeId: "api",
        text: "there might be a bug in how invoices are validated",
      }),
    );
    return;
  }
  if (msg.type === "turn.started" && typeof msg.turnId === "string") {
    // busy rejection check: a second prompt for the same daemon must fail.
    ws.send(
      JSON.stringify({
        type: "prompt",
        turnId: "duplicate-turn",
        nodeId: "api",
        text: "should be rejected with busy",
      }),
    );
    return;
  }
  if (msg.type === "permission.request" && !permissionAnswered) {
    permissionAnswered = true;
    ws.send(JSON.stringify({ type: "permission.response", requestId: msg.requestId, optionId: "allow" }));
    return;
  }
  if (msg.type === "turn.finished") {
    clearTimeout(timeout);
    ws.close();
    done(null);
  }
});

ws.on("error", (err) => done(`websocket error: ${err.message}`));
