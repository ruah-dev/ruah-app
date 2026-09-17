import {
  Brain,
  FileCode,
  Globe,
  ListChecks,
  MoveRight,
  Pencil,
  Search,
  ShieldAlert,
  Terminal,
  Trash2,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { ToolCallView } from "../lib/contract/index.js";

export const TOOL_ICONS: Record<string, LucideIcon> = {
  read: FileCode,
  edit: Pencil,
  delete: Trash2,
  move: MoveRight,
  search: Search,
  execute: Terminal,
  think: Brain,
  fetch: Globe,
  switch_mode: Wrench,
  other: Wrench,
};

export function toolIcon(kind: string): LucideIcon {
  return TOOL_ICONS[kind] ?? Wrench;
}

export const TOOL_STATUS_COLOR: Record<ToolCallView["status"], string> = {
  pending: "var(--muted-foreground)",
  in_progress: "var(--warn)",
  completed: "var(--ok)",
  failed: "var(--bad)",
};

export function planIcon(): LucideIcon {
  return ListChecks;
}

export { ShieldAlert };
