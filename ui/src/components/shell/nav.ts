// Pages of the shell and every keyboard shortcut, in one place: the icon rail, "G then a letter",
// the launcher's Pages group and its "Keyboard shortcuts" sheet all read from here.
//
// Rail decisions (2026-09-25 relayout): Map, Agent, Cloud, Tasks on top; the projects' tiles in
// between; Usage, Integrations, Extensions (reserved: shown once its route exists) and Settings
// at the bottom. The Advanced layout (⌘\) shows the same entries as labelled rows. Integrations
// stays its own page (not merged into Settings): it is a full
// page of providers and accounts, and Settings links to it. There is no "Infra" entry: IaC shows
// on the Map (its infra layer) and there is no separate page or filter for it. Home is the
// Ruah mark at the top of the rail; Chats (the full list) is reached from the agent panel's chat
// switcher, the launcher and G C.
import { useMemo } from "react";
import { useRouter } from "@tanstack/react-router";
import {
  BarChart3,
  Puzzle,
  Cloud,
  Home,
  ListChecks,
  Map as MapIcon,
  MessageSquare,
  MessagesSquare,
  Plug,
  Settings,
  type LucideIcon,
} from "lucide-react";

export type NavPath =
  | "/"
  | "/map"
  | "/agent"
  | "/chats"
  | "/tasks"
  | "/cloud"
  | "/usage"
  | "/integrations"
  | "/extensions"
  | "/settings";

export interface NavItemDef {
  to: NavPath;
  label: string;
  icon: LucideIcon;
  /** G then this key. */
  key: string;
  /** Where the page sits in the rail (null = not in the rail). */
  rail: "top" | "bottom" | null;
  /** Reserved slot: shown only once a route with this path is registered (./slots.ts). */
  optional?: boolean;
}

export const NAV: readonly NavItemDef[] = [
  // §20.5: Home = every project sorted by what needs you; the open project's dashboard is one click away.
  { to: "/", label: "Home", icon: Home, key: "h", rail: null },
  { to: "/map", label: "Map", icon: MapIcon, key: "m", rail: "top" },
  { to: "/agent", label: "Agent", icon: MessageSquare, key: "a", rail: "top" },
  { to: "/cloud", label: "Cloud", icon: Cloud, key: "l", rail: "top" },
  { to: "/tasks", label: "Tasks", icon: ListChecks, key: "t", rail: "top" },
  { to: "/chats", label: "Chats", icon: MessagesSquare, key: "c", rail: null },
  { to: "/usage", label: "Usage", icon: BarChart3, key: "u", rail: "bottom" },
  { to: "/integrations", label: "Integrations", icon: Plug, key: "i", rail: "bottom" },
  // Skills, MCP servers, Kiro powers, plugins (routes/extensions.tsx).
  { to: "/extensions", label: "Extensions", icon: Puzzle, key: "e", rail: "bottom" },
  { to: "/settings", label: "Settings", icon: Settings, key: "s", rail: "bottom" },
];

/** NAV without the reserved entries whose route is not registered (yet). */
export function useNav(): readonly NavItemDef[] {
  const router = useRouter();
  return useMemo(() => {
    const byPath = router.routesByPath as unknown as Record<string, unknown>;
    return NAV.filter((n) => !n.optional || n.to in byPath);
  }, [router]);
}

export function isActivePath(pathname: string, to: string) {
  return to === "/" ? pathname === "/" : pathname === to || pathname.startsWith(`${to}/`);
}

export function pageLabel(pathname: string): string {
  // A stored project view names the project's dashboard "/?view=project" (lib/view-restore.ts).
  if (pathname === "/?view=project") return "Project overview";
  return NAV.find((n) => isActivePath(pathname, n.to))?.label ?? "Ruah";
}

export interface ShortcutDef {
  keys: string;
  label: string;
  group: "Anywhere" | "Projects & chats" | "Map" | "Agent" | "Launcher";
}

/** Every shortcut the viewer handles (the launcher's "Keyboard shortcuts" item lists these). */
export const SHORTCUTS: readonly ShortcutDef[] = [
  { keys: "⌘K", label: "Launcher: search, jump, run (also ⌘P and /)", group: "Anywhere" },
  { keys: "G then a letter", label: `Go to a page (${NAV.filter((n) => !n.optional).map((n) => `${n.key.toUpperCase()} ${n.label}`).join(", ")})`, group: "Anywhere" },
  { keys: "⌘.", label: "Agent · model picker", group: "Anywhere" },
  { keys: "⌃`", label: "Toggle the terminal", group: "Anywhere" },
  { keys: "⌘I", label: "Toggle the agent panel", group: "Anywhere" },
  { keys: "⌘B", label: "Toggle the page drawer (Map outline, Agent turns)", group: "Anywhere" },
  { keys: "⌘\\", label: "Layout: Standard (icon rail) ⇄ Advanced (sidebar with projects and chats)", group: "Anywhere" },
  { keys: "⌥Space", label: "Focus Ruah and open the launcher from any app (desktop, off by default)", group: "Anywhere" },
  { keys: "⌘1 … ⌘9", label: "Open a pinned project", group: "Projects & chats" },
  { keys: "⌘O", label: "Open folder…", group: "Projects & chats" },
  { keys: "⇧⌘N", label: "New project…", group: "Projects & chats" },
  { keys: "⌘N", label: "New chat", group: "Projects & chats" },
  { keys: "⌘J", label: "Recent chats (hold ⌘, press J again to go further back)", group: "Projects & chats" },
  { keys: "⌘[ / ⌘]", label: "Previous / next chat of this project", group: "Projects & chats" },
  { keys: "Enter · double-click", label: "Open an element's level (drill in)", group: "Map" },
  { keys: "Esc · Backspace · ⌥↑", label: "Up one level (Esc first clears search / selection)", group: "Map" },
  { keys: "← ↑ → ↓", label: "Select the nearest element in that direction", group: "Map" },
  { keys: "⌘F", label: "Find on this level", group: "Map" },
  { keys: "F · ⇧F", label: "Fit the selection · fit everything", group: "Map" },
  { keys: "+ · −", label: "Zoom in · out", group: "Map" },
  { keys: "F2", label: "Rename the selected element", group: "Map" },
  { keys: "N", label: "New element", group: "Map" },
  { keys: "Del · ⌘⌫", label: "Remove the selected element (Edit mode)", group: "Map" },
  { keys: "⌘Z · ⇧⌘Z", label: "Undo · redo your map edits", group: "Map" },
  { keys: "Enter", label: "Send (Shift+Enter: new line)", group: "Agent" },
  { keys: "Enter", label: "Allow a waiting permission request once (Reject and Stop are buttons)", group: "Agent" },
  { keys: "↑ ↓ · Enter", label: "Move · open", group: "Launcher" },
  { keys: "⌘Enter", label: "Open in the background (warm a project, ask without showing the chat)", group: "Launcher" },
  { keys: "Tab", label: "Ask the agent what you typed", group: "Launcher" },
];
