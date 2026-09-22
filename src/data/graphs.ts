// Diagram model used by the canvas components. The data itself comes from architecture.json
// via src/lib/architecture.ts (sample fallback: src/data/sample-architecture.json).
export type NodeKind =
  // compute
  | "service"
  | "function"
  | "container"
  | "cluster"
  | "worker"
  // data
  | "database"
  | "cache"
  | "storage"
  | "warehouse"
  | "search"
  // messaging
  | "queue"
  | "topic"
  | "stream"
  | "webhook"
  | "scheduler"
  // edge + network
  | "gateway"
  | "loadbalancer"
  | "cdn"
  | "dns"
  | "firewall"
  // platform
  | "auth"
  | "secret"
  | "monitoring"
  | "analytics"
  | "config"
  | "ml"
  // clients
  | "frontend"
  | "mobile"
  | "user"
  | "external"
  // code
  | "module"
  | "file"
  | "api"
  // workflow
  | "step"
  | "decision"
  | "event"
  | "timer"
  | "approval"
  | "actor";

export type CodeFile = {
  repo: string;
  branch: string;
  path: string;
  lang: string;
  code: string;
  highlight?: [number, number];
  deps?: string[];
};

export type DiagramNode = {
  id: string;
  label: string;
  subtitle?: string;
  kind: NodeKind;
  x: number;
  y: number;
  w?: number;
  h?: number;
  drill?: string;
  description?: string;
  owner?: string;
  tech?: string[];
  endpoints?: string[];
  health?: { label: string; tone: "ok" | "warn" | "bad" }[];
  files?: CodeFile[];
  /** Fields carried over from architecture.json (see src/lib/architecture.ts). */
  type?: string;
  path?: string;
  notes?: string;
  layer?: string;
  parent?: string;
  filePaths?: string[];
};

export type DiagramEdge = {
  from: string;
  to: string;
  label?: string;
  animated?: boolean;
  kind?: string;
};

export type DiagramGroup = {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type Graph = {
  id: string;
  title: string;
  subtitle: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  groups?: DiagramGroup[];
};
