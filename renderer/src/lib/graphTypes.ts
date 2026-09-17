export type NodeKind =
  | "service"
  | "database"
  | "queue"
  | "external"
  | "frontend"
  | "gateway"
  | "module"
  | "file"
  | "step";

export type CodeFile = {
  path: string;
  lang: string;
  code: string;
  highlight?: [number, number];
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
  drill?: boolean;
  description?: string;
  notes?: string;
  tech?: string[];
  layer?: string;
  files?: CodeFile[];
};

export type DiagramEdge = {
  from: string;
  to: string;
  label?: string;
  animated?: boolean;
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

export type RepoTreeNode = {
  name: string;
  kind: "dir" | "file";
  children?: RepoTreeNode[];
  nodeId?: string;
  graphId?: string;
};
