// src/serve/context-endpoint.ts — GET /api/context/:nodeId returns the
// context pack as text/plain (CONTRACTS.md §2.3). With ?text=<user text>
// the endpoint returns exactly the string that would be sent to the agent
// for that prompt, including the user text; without it, the pack alone
// (see the CONTRACTS note in the final report: §3 does not state how the
// endpoint reconstructs the user text, so it serves the pack only).
import type { ServerResponse } from "node:http";
import type { ArchitectureStore } from "./architecture-store.js";
import { ArchIndex } from "../context/graph.js";
import { buildContextPack } from "../context/pack.js";

export function serveContext(
  store: ArchitectureStore,
  nodeId: string,
  text: string | undefined,
  res: ServerResponse,
): void {
  const arch = store.current();
  if (arch === null) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("architecture not loaded");
    return;
  }
  const index = new ArchIndex(arch, store.root);
  if (index.byId(nodeId) === undefined) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(`unknown node: ${nodeId}`);
    return;
  }
  const pack = buildContextPack(index, nodeId, store.root, text);
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end(pack);
}
