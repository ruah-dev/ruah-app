import {
  Boxes,
  Cloud,
  Database,
  FileCode,
  Folder,
  Globe,
  Layers,
  Radio,
  Server,
  Workflow,
} from "lucide-react";
import type { NodeKind } from "../lib/graphTypes";

export interface KindStyle {
  label: string;
  icon: typeof Server;
  /** oklch token name, used as color value on icons and accents */
  color: string;
}

export const kindStyles: Record<NodeKind, KindStyle> = {
  service: { label: "service", icon: Server, color: "var(--node-service)" },
  database: { label: "datastore", icon: Database, color: "var(--node-data)" },
  queue: { label: "queue", icon: Radio, color: "var(--node-queue)" },
  external: { label: "external", icon: Globe, color: "var(--node-external)" },
  frontend: { label: "frontend", icon: Layers, color: "var(--node-frontend)" },
  gateway: { label: "gateway", icon: Cloud, color: "var(--node-gateway)" },
  module: { label: "module", icon: Folder, color: "var(--node-step)" },
  file: { label: "file", icon: FileCode, color: "var(--node-file)" },
  step: { label: "step", icon: Workflow, color: "var(--node-step)" },
};

export const groupIcon = Boxes;
export const NODE_W = 200;
export const NODE_H = 64;
