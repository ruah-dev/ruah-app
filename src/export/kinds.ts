// src/export/kinds.ts — element type → kind → colour token, shared by the draw.io
// exporter (src/export/drawio.ts) and the journey lanes (src/product/lanes.ts).
// Mirrors the viewer: ui/src/components/explorer/kinds.ts (tokens) and
// ui/src/lib/architecture.ts kindFor (aliases).

export type Token = "service" | "frontend" | "data" | "queue" | "gateway" | "external" | "file" | "step";

// Kind → token, as ui/src/components/explorer/kinds.ts; aliases as ui/src/lib/architecture.ts kindFor.
export const KIND_TOKEN: Record<string, Token> = {
  service: "service", function: "service", container: "service", cluster: "service", worker: "service",
  database: "data", cache: "data", storage: "data", warehouse: "data", search: "data", approval: "data",
  queue: "queue", topic: "queue", stream: "queue", webhook: "queue", scheduler: "queue", decision: "queue", event: "queue",
  gateway: "gateway", loadbalancer: "gateway", cdn: "gateway", dns: "gateway", firewall: "gateway",
  auth: "step", secret: "step", monitoring: "step", analytics: "step", config: "step", ml: "step", step: "step",
  frontend: "frontend", mobile: "frontend", user: "frontend", actor: "frontend",
  external: "external", timer: "external",
  module: "file", file: "file", api: "file",
};

export const TYPE_ALIASES: Record<string, string> = {
  datastore: "database", db: "database", sql: "database", bucket: "storage", blob: "storage", "object-store": "storage",
  bus: "queue", broker: "queue", "third-party": "external", thirdparty: "external", saas: "external", vendor: "external",
  web: "frontend", ui: "frontend", client: "frontend", spa: "frontend", site: "frontend",
  proxy: "gateway", ingress: "gateway", edge: "gateway", "load-balancer": "loadbalancer",
  lambda: "function", serverless: "function", job: "worker", daemon: "service", server: "service", backend: "service",
  microservice: "service", package: "module", library: "module", lib: "module", entry: "module", app: "module",
  component: "module", person: "actor", role: "actor",
  // §11 infrastructure-as-code types
  cloud: "cluster", pipeline: "worker", registry: "storage",
};

export function kindOf(type: string): string {
  const t = type.toLowerCase();
  const alias = TYPE_ALIASES[t];
  if (alias !== undefined) return alias;
  return KIND_TOKEN[t] !== undefined ? t : "module";
}

export function tokenOf(type: string): Token {
  return KIND_TOKEN[kindOf(type)] ?? "file";
}
