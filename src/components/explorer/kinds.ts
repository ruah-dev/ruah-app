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
  /** token color class used for icon + accent line */
  color: string;
  border: string;
  glow: string;
};

const make = (
  label: string,
  icon: typeof Server,
  token: "service" | "data" | "queue" | "external" | "frontend" | "gateway" | "step" | "file",
): KindStyle => ({
  label,
  icon,
  color: `text-node-${token}`,
  border: `border-node-${token}/35`,
  glow: `shadow-[0_0_0_1px_var(--node-${token})]`,
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
  module: make("module", Folder, "step"),
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
