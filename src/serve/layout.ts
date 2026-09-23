import type { Architecture } from "../contracts/architecture.js";

// Column by node type (PLAN.md 2.3): frontend/external → 0, gateway → 1,
// service/module/other → 2, datastore/queue → 3. Shared with src/scan/layout.ts.
export function typeColumn(type: string): number {
  return type === "frontend" || type === "external" ? 0
    : type === "gateway" ? 1
    : type === "datastore" || type === "queue" ? 3 : 2;
}

export function layout(architecture: Architecture): Architecture {
  const rows = [0, 0, 0, 0];
  return {
    ...architecture,
    nodes: architecture.nodes.map((node) => {
      const column = typeColumn(node.type);
      const row = rows[column] ?? 0;
      rows[column] = row + 1;
      return node.x !== undefined && node.y !== undefined ? node : { ...node, x: column * 260, y: row * 110 };
    }),
  };
}
