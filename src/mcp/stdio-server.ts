// src/mcp/stdio-server.ts — `archmap mcp --daemon <url>`: a minimal MCP
// server over stdio (newline-delimited JSON-RPC 2.0, MCP 2025-06-18) for ACP
// agents, which get it through session/new `mcpServers`. It lists the ruah_*
// tools and forwards every call to the running daemon (GET /api/arch,
// POST /api/arch/ops) with the per-session capability token the daemon put in
// its environment (RUAH_MCP_TOKEN, or --token). Hand-rolled on purpose: five
// methods, no new dependency.
import { createInterface } from "node:readline";
import type { Architecture } from "../contracts/architecture.js";
import type { ArchOp, ArchOpsResponse } from "../contracts/map.js";
import { callMapTool, MAP_SERVER_INSTRUCTIONS, MAP_SERVER_NAME, mapToolList, MapToolError, type MapBackend } from "./tools.js";

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const MCP_TOKEN_HEADER = "x-ruah-token";

/** MapBackend over the daemon's token-authenticated HTTP API. */
export function httpMapBackend(daemonUrl: string, token: string, fetchImpl: typeof fetch = fetch): MapBackend {
  const base = daemonUrl.replace(/\/+$/, "");
  const call = async <T>(path: string, body?: unknown): Promise<T> => {
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { [MCP_TOKEN_HEADER]: token, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new MapToolError(`the Ruah daemon at ${base} is not reachable (${(err as Error).message}) — is Ruah still running?`);
    }
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new MapToolError(data.error ?? `daemon answered ${res.status}`);
    return data;
  };
  return {
    read: () => call<{ architecture: Architecture; revision: number }>("/api/arch"),
    apply: (ops: ArchOp[]) => call<ArchOpsResponse>("/api/arch/ops", { ops }),
  };
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** Serves MCP on the given streams until input ends. Returns the exit code. */
export function serveMcpStdio(
  backend: MapBackend,
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream; version: string; log?: (line: string) => void },
): Promise<number> {
  const send = (message: Record<string, unknown>): void => {
    io.output.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  const reply = (id: JsonRpcMessage["id"], result: unknown): void => send({ id: id ?? null, result });
  const fail = (id: JsonRpcMessage["id"], code: number, message: string): void => send({ id: id ?? null, error: { code, message } });

  const handle = async (msg: JsonRpcMessage): Promise<void> => {
    const isRequest = msg.id !== undefined && msg.id !== null;
    switch (msg.method) {
      case "initialize": {
        const asked = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : undefined;
        reply(msg.id, {
          protocolVersion: asked !== undefined && SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MAP_SERVER_NAME, title: "Ruah architecture map", version: io.version },
          instructions: MAP_SERVER_INSTRUCTIONS,
        });
        return;
      }
      case "ping":
        if (isRequest) reply(msg.id, {});
        return;
      case "tools/list":
        reply(msg.id, { tools: mapToolList() });
        return;
      case "tools/call": {
        const name = typeof msg.params?.name === "string" ? msg.params.name : "";
        reply(msg.id, await callMapTool(name, msg.params?.arguments ?? {}, backend));
        return;
      }
      default:
        // Notifications (initialized, cancelled, …) need no answer.
        if (isRequest) fail(msg.id, -32601, `method not found: ${msg.method ?? "(none)"}`);
    }
  };

  return new Promise((resolve) => {
    const rl = createInterface({ input: io.input, crlfDelay: Infinity });
    const pending = new Set<Promise<void>>();
    rl.on("line", (line) => {
      const text = line.trim();
      if (text.length === 0) return;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(text) as JsonRpcMessage;
      } catch {
        fail(null, -32700, "parse error");
        return;
      }
      const p = handle(msg).catch((err: unknown) => {
        io.log?.(`archmap mcp: ${String(err)}`);
        if (msg.id !== undefined && msg.id !== null) fail(msg.id, -32603, err instanceof Error ? err.message : String(err));
      });
      pending.add(p);
      void p.finally(() => pending.delete(p));
    });
    rl.on("close", () => {
      void Promise.allSettled([...pending]).then(() => resolve(0));
    });
  });
}
