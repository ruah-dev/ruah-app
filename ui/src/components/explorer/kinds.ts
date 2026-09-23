import {
  Activity,
  BarChart3,
  Bell,
  Box,
  Boxes,
  BrainCircuit,
  Braces,
  CheckCircle2,
  Clock,
  Cloud,
  Cpu,
  Database,
  FileCode2,
  Folder,
  GitFork,
  Globe,
  Globe2,
  HardDrive,
  KeyRound,
  Layers,
  Lock,
  Megaphone,
  MemoryStick,
  Radio,
  Scale,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Server,
  Timer,
  UserRound,
  Users,
  Warehouse,
  Waves,
  Webhook,
  Workflow,
  Zap,
} from "lucide-react";
import type { NodeKind } from "@/data/graphs";

type KindStyle = {
  label: string;
  icon: typeof Server;
  /** token color class used for the icon */
  color: string;
  /** kind-tinted border (selected / accent) */
  border: string;
  /** kind-tinted icon tile background */
  tint: string;
  /** kind accent bar on the node's leading edge */
  bar: string;
  glow: string;
};

type Token = "service" | "data" | "queue" | "external" | "frontend" | "gateway" | "step" | "file";

// Literal class names: Tailwind only generates classes it can find verbatim in the source.
// Kind → Ruah palette: service teal · frontend lavender · data sage · queue amber · gateway coral ·
// external slate · file + module warm neutral · step pale lavender (see styles.css --node-*).
const TOKEN_CLASSES: Record<Token, Omit<KindStyle, "label" | "icon">> = {
  service: {
    color: "text-node-service",
    border: "border-node-service/35",
    tint: "bg-node-service/14",
    bar: "bg-node-service",
    glow: "shadow-[0_0_0_1px_var(--node-service)]",
  },
  data: {
    color: "text-node-data",
    border: "border-node-data/35",
    tint: "bg-node-data/14",
    bar: "bg-node-data",
    glow: "shadow-[0_0_0_1px_var(--node-data)]",
  },
  queue: {
    color: "text-node-queue",
    border: "border-node-queue/35",
    tint: "bg-node-queue/14",
    bar: "bg-node-queue",
    glow: "shadow-[0_0_0_1px_var(--node-queue)]",
  },
  external: {
    color: "text-node-external",
    border: "border-node-external/35",
    tint: "bg-node-external/14",
    bar: "bg-node-external",
    glow: "shadow-[0_0_0_1px_var(--node-external)]",
  },
  frontend: {
    color: "text-node-frontend",
    border: "border-node-frontend/35",
    tint: "bg-node-frontend/14",
    bar: "bg-node-frontend",
    glow: "shadow-[0_0_0_1px_var(--node-frontend)]",
  },
  gateway: {
    color: "text-node-gateway",
    border: "border-node-gateway/35",
    tint: "bg-node-gateway/14",
    bar: "bg-node-gateway",
    glow: "shadow-[0_0_0_1px_var(--node-gateway)]",
  },
  step: {
    color: "text-node-step",
    border: "border-node-step/35",
    tint: "bg-node-step/14",
    bar: "bg-node-step",
    glow: "shadow-[0_0_0_1px_var(--node-step)]",
  },
  file: {
    color: "text-node-file",
    border: "border-node-file/35",
    tint: "bg-node-file/14",
    bar: "bg-node-file",
    glow: "shadow-[0_0_0_1px_var(--node-file)]",
  },
};

const make = (label: string, icon: typeof Server, token: Token): KindStyle => ({
  label,
  icon,
  ...TOKEN_CLASSES[token],
});

export const kindStyles: Record<NodeKind, KindStyle> = {
  // compute
  service: make("service", Server, "service"),
  function: make("function", Zap, "service"),
  container: make("container", Box, "service"),
  cluster: make("cluster", Boxes, "service"),
  worker: make("worker", Cpu, "service"),
  // data
  database: make("datastore", Database, "data"),
  cache: make("cache", MemoryStick, "data"),
  storage: make("object storage", HardDrive, "data"),
  warehouse: make("warehouse", Warehouse, "data"),
  search: make("search index", Search, "data"),
  // messaging
  queue: make("queue", Radio, "queue"),
  topic: make("topic", Megaphone, "queue"),
  stream: make("stream", Waves, "queue"),
  webhook: make("webhook", Webhook, "queue"),
  scheduler: make("scheduler", Clock, "queue"),
  // edge + network
  gateway: make("gateway", Cloud, "gateway"),
  loadbalancer: make("load balancer", Scale, "gateway"),
  cdn: make("CDN", Globe2, "gateway"),
  dns: make("DNS", Globe, "gateway"),
  firewall: make("firewall", ShieldCheck, "gateway"),
  // platform
  auth: make("auth", KeyRound, "step"),
  secret: make("secrets", Lock, "step"),
  monitoring: make("monitoring", Activity, "step"),
  analytics: make("analytics", BarChart3, "step"),
  config: make("config", SlidersHorizontal, "step"),
  ml: make("model", BrainCircuit, "step"),
  // clients
  frontend: make("frontend", Layers, "frontend"),
  mobile: make("mobile app", Smartphone, "frontend"),
  user: make("user group", Users, "frontend"),
  external: make("external", Globe, "external"),
  // code
  module: make("module", Folder, "file"),
  file: make("file", FileCode2, "file"),
  api: make("api contract", Braces, "file"),
  // workflow
  step: make("step", Workflow, "step"),
  decision: make("decision", GitFork, "queue"),
  event: make("event", Bell, "queue"),
  timer: make("wait", Timer, "external"),
  approval: make("approval", CheckCircle2, "data"),
  actor: make("actor", UserRound, "frontend"),
};

export const groupIcon = Boxes;

export const NODE_W = 200;
export const NODE_H = 64;
