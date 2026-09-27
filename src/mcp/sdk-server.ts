// src/mcp/sdk-server.ts — the ruah_* tools as an in-process MCP server for the
// Claude Agent SDK (createSdkMcpServer + tool()): no subprocess, no token, the
// handlers call the daemon's MapOpsService directly. A fresh server per
// query(): an McpServer instance connects to one transport at a time.
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { callMapTool, DESTRUCTIVE_TOOLS, MAP_SERVER_INSTRUCTIONS, MAP_SERVER_NAME, MAP_TOOLS, type MapBackend } from "./tools.js";

export function createMapSdkServer(backend: MapBackend, version: string): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: MAP_SERVER_NAME,
    version,
    instructions: MAP_SERVER_INSTRUCTIONS,
    // Always in the prompt (not deferred behind tool search): the agent should see the map tools up front.
    alwaysLoad: true,
    tools: MAP_TOOLS.map((def) =>
      tool(def.name, def.description, def.shape, (args) => callMapTool(def.name, args, backend), {
        annotations: { readOnlyHint: def.readOnly, destructiveHint: DESTRUCTIVE_TOOLS.has(def.name) },
      }),
    ),
  });
}
