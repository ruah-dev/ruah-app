import type { Architecture } from "../contracts/architecture.js";

export function layout(architecture: Architecture): Architecture {
  const rows = [0, 0, 0, 0];
  return {
    ...architecture,
    nodes: architecture.nodes.map((node) => {
      const column = node.type === "frontend" || node.type === "external" ? 0
        : node.type === "gateway" ? 1
        : node.type === "datastore" || node.type === "queue" ? 3 : 2;
      const row = rows[column] ?? 0;
      rows[column] = row + 1;
      return node.x !== undefined && node.y !== undefined ? node : { ...node, x: column * 260, y: row * 110 };
    }),
  };
}
