#!/usr/bin/env node
// test/fixtures/extensions/tiny-mcp.mjs — the smallest useful stdio MCP server
// (newline-delimited JSON-RPC 2.0, no dependencies): initialize, tools/list,
// tools/call with one tool, tiny_ping. TINY_MCP_LOG=<file> appends one line per
// request (method + whether TINY_TOKEN is set, never its value) so tests and
// live checks can prove an agent started it with the expected environment.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = (line) => {
  if (process.env.TINY_MCP_LOG) appendFileSync(process.env.TINY_MCP_LOG, `${line}\n`);
};
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const tokenState = () => (process.env.TINY_TOKEN ? "set" : "unset");

log(`start pid=${process.pid} token=${tokenState()} args=${JSON.stringify(process.argv.slice(2))}`);

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof msg.method !== "string") return;
  log(`${msg.method} token=${tokenState()}`);
  if (msg.id === undefined) return; // notification
  switch (msg.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "tiny", version: "1.0.0" },
        },
      });
      return;
    case "ping":
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;
    case "tools/list":
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: [
            {
              name: "tiny_ping",
              description: "Answers pong and says whether TINY_TOKEN reached the server (never its value).",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            },
          ],
        },
      });
      return;
    case "tools/call":
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: `pong from tiny (TINY_TOKEN ${tokenState()})` }] },
      });
      return;
    default:
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
});
