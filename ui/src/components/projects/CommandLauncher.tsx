// ⌘K (⌘P, /, the top-bar field): one Raycast-style launcher over everything — what needs you,
// recents, projects and systems, chats of every project, the map's elements (drilled levels too),
// the project's cloud resources, pages and actions. Keyboard-first: ↑↓, Enter, ⌘Enter (in the
// background), Tab (ask the agent what you typed), Esc. A keystroke only re-ranks what the stores
// already hold (lib/launcher.ts); chats of other projects are fetched once when it opens.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  Bot,
  CircleHelp,
  Cloud,
  Download,
  FolderOpen,
  FolderPlus,
  History,
  Home,
  Keyboard,
  Layers,
  List,
  MessageSquarePlus,
  Moon,
  PanelLeft,
  PanelRight,
  RefreshCw,
  ScanSearch,
  Search,
  Settings,
  Sparkles,
  SquareTerminal,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { ActivityEvent, CloudResource } from "@/lib/contracts";
import { kindFor } from "@/lib/architecture";
import {
  openActivityTarget,
  prefetchChat,
  prefetchProject,
  rescan,
  sendPrompt,
  setAgent,
  setModel,
  setScanOptions,
} from "@/lib/daemon";
import { requestModelPicker } from "@/lib/bus";
import { requestComposerDraft } from "@/lib/composer-draft";
import { downloadDrawio } from "@/lib/export";
import { invalidateExpansions } from "@/lib/expand";
import { useActivity } from "@/lib/activity";
import { needsYou } from "@/lib/activity-feed";
import { providerLabel, syncCloud } from "@/lib/integrations";
import { flattenRanked, moveActive, rankLauncher, type LauncherItem } from "@/lib/launcher";
import { useMruChats } from "@/lib/mru";
import { openSystemDialog } from "@/lib/system";
import { useTheme, type ThemePref } from "@/lib/theme";
import { prettyPath, relativeTime } from "@/lib/time";
import { useWorkspace } from "@/lib/workspace";
import { useWorkbench } from "@/lib/workbench";
import { AgentMark } from "@/components/agent/ComposerControls";
import { openRecentChatsSwitcher } from "@/components/chats/RecentChatsSwitcher";
import { kindStyles } from "@/components/explorer/kinds";
import { useNav } from "@/components/shell/nav";
import { setShellDialog } from "@/components/shell/shellState";
import { useProjectCloud } from "@/components/shell/useCloudAttention";
import { newTerminal } from "@/components/terminal/TerminalPanel";
import { openElementInTerminal } from "@/components/terminal/actions";
import { runInTerminal } from "@/lib/terminal";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { ProjectTile, pinnedShortcut } from "./ProjectBits";
import { useProjectActions } from "./useProjectActions";
import { useRecentChats } from "./useRecentChats";

type Tone = "warn" | "ok" | "bad" | "ai" | "muted";

interface Row extends LauncherItem {
  /** The 22px square on the left. */
  tile: ReactNode;
  badge?: { label: string; tone: Tone } | undefined;
  kbd?: string | undefined;
  run: () => void;
  /** ⌘Enter: act without leaving what you are looking at (warm a project, ask quietly …). */
  background?: (() => void) | undefined;
  /** Warm what Enter would open (debounced while highlighted). */
  prefetch?: (() => void) | undefined;
}

const badgeTone: Record<Tone, string> = {
  warn: "bg-warn/15 text-warn",
  ok: "bg-ok/15 text-ok",
  bad: "bg-bad/15 text-bad",
  ai: "bg-ai/15 text-ai",
  muted: "bg-surface-3 text-muted-foreground",
};

function IconTile({ icon: Icon, className }: { icon: LucideIcon; className?: string }) {
  return (
    <span className="grid size-[22px] shrink-0 place-items-center rounded-md bg-surface-3 text-muted-foreground">
      <Icon className={cn("size-3.5", className)} />
    </span>
  );
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function healthBadge(r: CloudResource): Row["badge"] {
  if (r.health === "down") return { label: "down", tone: "bad" };
  if (r.health === "degraded") return { label: "degraded", tone: "warn" };
  if (r.health === "deploying") return { label: "deploying", tone: "ai" };
  return undefined;
}

function eventBadge(e: ActivityEvent): Row["badge"] {
  if (e.kind === "permission.requested") return { label: "permission", tone: "warn" };
  if (e.stopReason === "end_turn") return { label: "done", tone: "ok" };
  if (e.stopReason === "cancelled") return { label: "stopped", tone: "muted" };
  return { label: "failed", tone: "bad" };
}

export function CommandLauncher() {
  const wb = useWorkbench();
  const open = wb.paletteOpen;
  return (
    <Dialog open={open} onOpenChange={wb.setPaletteOpen}>
      <DialogContent className="top-[12%] w-[calc(100vw-2rem)] max-w-[680px] translate-y-0 grid-cols-[minmax(0,1fr)] gap-0 overflow-hidden rounded-2xl border-hairline bg-popover p-0 shadow-2xl [&>button]:hidden">
        <DialogTitle className="sr-only">Search, jump, run</DialogTitle>
        {open ? <LauncherBody /> : null}
      </DialogContent>
    </Dialog>
  );
}

function LauncherBody() {
  const ws = useWorkspace();
  const { daemon } = ws;
  const wb = useWorkbench();
  const router = useRouter();
  const actions = useProjectActions();
  const activity = useActivity();
  const mru = useMruChats();
  const chats = useRecentChats(daemon, true);
  const cloud = useProjectCloud();
  const [theme, setTheme] = useTheme();
  const nav = useNav();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const prefetchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(prefetchTimer.current), []);

  const current = daemon.project;
  const connected = actions.connected;
  const live = daemon.source === "daemon" && daemon.connection === "open";
  const close = () => wb.setPaletteOpen(false);
  const go = (to: string) => {
    close();
    void router.navigate({ to: to as "/" });
  };
  const agentName = (id: string) => daemon.agent?.agents?.available.find((a) => a.id === id)?.name ?? id;
  const recentRoot = (projectId: string) => daemon.recentProjects.find((p) => p.id === projectId)?.root;

  // The rows that do not depend on the query. Rebuilt when a store changes, not per keystroke.
  const baseRows = useMemo<Row[]>(() => {
    const rows: Row[] = [];
    const openChat = (c: { id: string; projectId: string; projectName: string; projectRoot?: string | undefined }) => {
      const root = c.projectRoot ?? recentRoot(c.projectId);
      if (root) void actions.showChat({ id: c.id, projectId: c.projectId, projectName: c.projectName, projectRoot: root });
      else void actions.showChat({ id: c.id, projectId: c.projectId });
    };

    // Needs you: waiting permissions and finished background turns, then unhealthy cloud.
    for (const e of needsYou(activity.recent, activity.projects, 5)) {
      rows.push({
        id: `need:${e.id}`,
        group: "Needs you",
        label: e.projectName,
        sub: e.summary,
        keywords: ["needs", "attention", e.kind],
        tile: <ProjectTile project={{ id: e.projectId, name: e.projectName }} className="size-[22px] text-[10.5px]" />,
        badge: eventBadge(e),
        run: () => {
          close();
          if (e.chatId) openChat({ id: e.chatId, projectId: e.projectId, projectName: e.projectName, projectRoot: e.projectRoot });
          else void openActivityTarget({ projectId: e.projectId, ...(e.projectRoot ? { projectRoot: e.projectRoot } : {}) });
        },
      });
    }
    for (const r of cloud.unhealthy.slice(0, 3)) {
      rows.push({
        id: `need-cloud:${r.id}`,
        group: "Needs you",
        label: r.name,
        sub: [providerLabel(r.provider), r.healthDetail ?? r.region].filter(Boolean).join(" · "),
        keywords: ["cloud", r.type, r.service],
        target: `cloud:${r.id}`,
        tile: <IconTile icon={Cloud} className="text-warn" />,
        badge: healthBadge(r),
        run: () => go("/cloud"),
      });
    }

    // Projects and systems (the open one last, so ↵ on the first project jumps back).
    const pinned = daemon.recentProjects.filter((p) => p.pinned);
    const projects = [
      ...daemon.recentProjects.filter((p) => p.id !== current?.id),
      ...daemon.recentProjects.filter((p) => p.id === current?.id),
    ];
    const projectRows = projects.map((p): Row => {
      const isCurrent = p.id === current?.id;
      const shortcut = pinnedShortcut(pinned.findIndex((x) => x.id === p.id));
      return {
        id: `project:${p.id}`,
        group: "Projects",
        label: p.name,
        sub: isCurrent ? `open · ${prettyPath(p.root)}` : prettyPath(p.root),
        keywords: [p.root, "project", p.kind],
        target: `project:${p.id}`,
        recentAt: Date.parse(p.lastOpenedAt) || undefined,
        tile: <ProjectTile project={p} className="size-[22px] text-[10.5px]" />,
        badge: p.kind === "system" ? { label: "system", tone: "ai" } : undefined,
        kbd: shortcut ?? undefined,
        run: () => {
          close();
          if (!isCurrent) void actions.openRecent(p);
        },
        background: isCurrent
          ? undefined
          : () => {
              void prefetchProject(p.id);
              toast.message(`${p.name} is warmed up`, { description: "Switching to it will be instant." });
            },
        prefetch: isCurrent ? undefined : () => void prefetchProject(p.id),
      };
    });

    // Recent: the project you came from, then the chats you visited (any project).
    const previous = projectRows[0];
    if (previous && projects[0]?.id !== current?.id) rows.push({ ...previous, id: `recent-${previous.id}`, group: "Recent" });
    const activeChat = daemon.activeChatId;
    for (const c of mru.filter((m) => m.chatId !== activeChat).slice(0, 4)) {
      rows.push({
        id: `recent-chat:${c.chatId}`,
        group: "Recent",
        label: c.title || "Untitled chat",
        sub: `chat · ${c.projectName} · ${relativeTime(c.at)}`,
        keywords: [c.projectName, agentName(c.agentId), "chat"],
        target: `chat:${c.chatId}`,
        recentAt: c.at,
        tile: <AgentMark name={agentName(c.agentId)} className="size-[22px] rounded-md text-[9px]" />,
        run: () => {
          close();
          openChat({ id: c.chatId, projectId: c.projectId, projectName: c.projectName, projectRoot: c.projectRoot });
        },
        prefetch: () => {
          void prefetchChat(c.projectId, c.chatId);
          if (c.projectId !== current?.id) void prefetchProject(c.projectId);
        },
      });
    }

    rows.push(...projectRows);

    // Chats of every project, most recent first.
    for (const c of chats.slice(0, 150)) {
      const isActive = c.projectId === current?.id && c.id === activeChat;
      rows.push({
        id: `chat:${c.id}`,
        group: "Chats",
        label: c.title || "Untitled chat",
        sub: `${c.projectName} · ${isActive ? "current" : relativeTime(c.updatedAt)}`,
        keywords: [agentName(c.agentId), "chat"],
        target: `chat:${c.id}`,
        recentAt: Date.parse(c.updatedAt) || undefined,
        tile: <AgentMark name={agentName(c.agentId)} className="size-[22px] rounded-md text-[9px]" />,
        run: () => {
          close();
          openChat({ id: c.id, projectId: c.projectId, projectName: c.projectName, projectRoot: c.projectRoot });
        },
        prefetch: () => {
          void prefetchChat(c.projectId, c.id);
          if (c.projectId !== current?.id) void prefetchProject(c.projectId);
        },
      });
    }

    // Elements of the map (stored and drilled-in levels) and workflows.
    const parents = new Map(ws.mapArchitecture.nodes.map((n) => [n.id, n.name]));
    for (const n of ws.mapArchitecture.nodes) {
      const kind = kindStyles[kindFor(n.type)];
      const where = n.path ?? (n.parent ? parents.get(n.parent) : undefined) ?? "top level";
      rows.push({
        id: `el:${n.id}`,
        group: "Elements",
        label: n.name,
        sub: `${where} · ${n.type}`,
        keywords: [n.id, n.type, ...(n.files ?? []).slice(0, 5)],
        queryOnly: true,
        tile: <IconTile icon={kind.icon} className={kind.color} />,
        run: () => {
          close();
          wb.openNode(n.id);
        },
      });
    }
    for (const w of ws.architecture.workflows) {
      rows.push({
        id: `flow:${w.id}`,
        group: "Elements",
        label: w.name,
        sub: "workflow",
        keywords: ["workflow", w.id],
        queryOnly: true,
        tile: <IconTile icon={Workflow} />,
        run: () => {
          close();
          wb.openDiagram(`flow:${w.id}`);
        },
      });
    }

    // The project's cloud resources.
    for (const r of cloud.resources) {
      rows.push({
        id: `cloud:${r.id}`,
        group: "Cloud",
        label: r.name,
        sub: [providerLabel(r.provider), r.service, r.region].filter(Boolean).join(" · "),
        keywords: [r.type, r.provider, ...(r.hosts ?? [])],
        target: `cloud:${r.id}`,
        queryOnly: !healthBadge(r),
        tile: <IconTile icon={Cloud} />,
        badge: healthBadge(r),
        run: () => go("/cloud"),
      });
    }

    // Pages.
    for (const n of nav) {
      rows.push({
        id: `page:${n.to}`,
        group: "Pages",
        label: n.label,
        sub: "page",
        keywords: ["page", "go"],
        queryOnly: true,
        tile: <IconTile icon={n.icon} />,
        kbd: `G ${n.key.toUpperCase()}`,
        run: () => go(n.to),
      });
    }

    // Actions (the first eight show without a query).
    const act = (
      id: string,
      label: string,
      icon: LucideIcon,
      run: () => void,
      extra: Partial<Pick<Row, "sub" | "kbd" | "keywords" | "queryOnly" | "background">> = {},
    ) => rows.push({ id: `a:${id}`, group: "Actions", label, tile: <IconTile icon={icon} />, run, ...extra });

    if (current && live) {
      act("ask", "Ask the agent about this project…", Sparkles, () => {
        close();
        wb.ask();
      }, { kbd: "Tab", keywords: ["agent", "chat", "prompt"] });
      act("terminal", "New terminal", SquareTerminal, () => {
        close();
        newTerminal();
      }, { sub: "shell in the project root", kbd: "⌃`", keywords: ["run", "shell", "console"] });
      act("new-chat", "New chat", MessageSquarePlus, actions.startChat, { kbd: "⌘N" });
    }
    if (live && daemon.agent?.agents) {
      act("model", "Switch agent or model…", Bot, () => {
        close();
        if (!requestModelPicker()) void router.navigate({ to: "/agent" });
      }, { kbd: "⌘.", keywords: ["agent", "model", "claude", "cursor"] });
    }
    if (current && live) {
      act("sync-cloud", "Sync cloud", Cloud, () => {
        close();
        void syncCloud({}).then((r) =>
          r.ok ? toast.success("Cloud synced", { description: `${r.data.resources.length} resources` }) : toast.error("Cloud sync failed", { description: r.message }),
        );
      }, { sub: "this project's accounts", keywords: ["refresh", "providers", "status"] });
      const doRescan = (infra: boolean) => {
        close();
        const id = toast.loading(infra ? "Scanning with infrastructure-as-code…" : "Rescanning…");
        void (infra ? setScanOptions({ infra: true }) : Promise.resolve(null))
          .then(() => rescan())
          .then((r) => {
            invalidateExpansions();
            toast.success(`Found ${r.nodes} elements`, { id, description: `${r.edges} links · ${Math.round(r.ms)} ms` });
          })
          .catch((err: unknown) => toast.error("Scan failed", { id, description: message(err) }));
      };
      act("rescan", "Rescan project", RefreshCw, () => doRescan(false), { sub: "0 tokens", keywords: ["scan", "refresh", "map"] });
      act("scan-infra", "Scan infrastructure (Terraform, Kubernetes, Helm, Ansible)", ScanSearch, () => doRescan(true), {
        sub: "turns IaC on for this project",
        keywords: ["iac", "infra", "scan", "terraform", "k8s"],
      });
    }
    act("shortcuts", "Keyboard shortcuts", Keyboard, () => {
      close();
      setShellDialog("shortcuts", true);
    }, { keywords: ["keys", "help", "hotkeys"] });

    // Query-only actions.
    const more = (id: string, label: string, icon: LucideIcon, run: () => void, extra: Partial<Pick<Row, "sub" | "kbd" | "keywords">> = {}) =>
      act(id, label, icon, run, { ...extra, queryOnly: true });
    more("recent-chats", "Recent chats", History, () => {
      close();
      openRecentChatsSwitcher();
    }, { kbd: "⌘J" });
    more("open-folder", "Open folder…", FolderOpen, () => void actions.pickFolder(), { kbd: "⌘O", keywords: ["project", "repo"] });
    more("new-project", "New project…", FolderPlus, actions.newProject, { kbd: "⇧⌘N" });
    if (connected) more("new-system", "New system…", Layers, () => {
      close();
      openSystemDialog({ kind: "new" });
    }, { sub: "several repos as one map", keywords: ["multi-repo", "monorepo"] });
    if (connected && current) {
      if (current.kind === "system") {
        more("repos", "Repos…", Layers, () => {
          close();
          openSystemDialog({ kind: "manage", tab: "repos" });
        }, { keywords: ["system"] });
        more("connections", "Suggest connections…", Layers, () => {
          close();
          openSystemDialog({ kind: "manage", tab: "connections" });
        }, { keywords: ["system", "edges"] });
      } else {
        more("add-repo", "Add another repo…", Layers, () => {
          close();
          openSystemDialog({ kind: "new", seedRepos: [current.root] });
        }, { sub: "turn this project into a system", keywords: ["system", "multi-repo"] });
      }
    }
    more("all-projects", "All projects…", List, () => {
      close();
      setShellDialog("allProjects", true);
    });
    more("start", "Start screen", Home, () => {
      close();
      wb.setLauncherOpen(true);
    }, { keywords: ["home", "launcher"] });
    more("all-chats", "All chats", History, () => go("/chats"), { keywords: ["history"] });
    if (wb.selectedNode && live && (wb.selectedNode.path || wb.selectedNode.filePaths?.length)) {
      const node = wb.selectedNode;
      more("el-terminal", `Open ${node.label} in terminal`, SquareTerminal, () => {
        close();
        openElementInTerminal(node);
      });
    }
    more("panel", wb.showPanel ? "Hide agent panel" : "Show agent panel", PanelRight, () => {
      close();
      wb.setShowPanel((v) => !v);
    }, { kbd: "⌘I" });
    more("drawer", wb.outlineOpen ? "Hide outline" : "Show outline", PanelLeft, () => {
      close();
      wb.setOutlineOpen((v) => !v);
    }, { kbd: "⌘B", keywords: ["drawer", "tree", "sidebar"] });
    if (live) more("export", "Export → draw.io", Download, () => {
      close();
      void downloadDrawio(daemon.httpOrigin);
    }, { keywords: ["diagram", "download"] });
    more("settings-features", "Features & behaviour", Settings, () => go("/settings"), {
      keywords: ["background agents", "notifications", "options", "preferences"],
    });
    more("getting-started", "Getting started", CircleHelp, () => {
      close();
      wb.setOnboardingOpen(true);
      wb.setLauncherOpen(true);
    }, { keywords: ["help", "onboarding"] });
    const themes: { value: ThemePref; label: string }[] = [
      { value: "dark", label: "Dark" },
      { value: "light", label: "Light" },
      { value: "contrast", label: "High contrast" },
      { value: "system", label: "System" },
    ];
    for (const t of themes) {
      if (t.value === theme) continue;
      more(`theme-${t.value}`, `Theme: ${t.label}`, Moon, () => setTheme(t.value), { keywords: ["theme", "appearance", "color"] });
    }
    // Agents and their models.
    const agents = daemon.agent?.agents;
    if (live && agents) {
      for (const a of agents.available) {
        if (!a.installed || a.id === agents.currentAgentId) continue;
        more(`agent-${a.id}`, `Switch agent to ${a.name}`, Bot, () => {
          close();
          if (setAgent(a.id)) toast.message(`Switching to ${a.name}`);
        }, { sub: a.warm === "ready" ? "warm, instant" : "starts it", keywords: ["agent"] });
      }
      const models = daemon.agent?.models;
      for (const m of models?.available ?? []) {
        if (m.id === models?.currentModelId) continue;
        more(`model-${m.id}`, `Use model ${m.name}`, Bot, () => {
          close();
          setModel(m.id);
        }, { sub: agentName(agents.currentAgentId), keywords: ["model"] });
      }
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity.recent, activity.projects, cloud, mru, chats, daemon.recentProjects, daemon.activeChatId, daemon.agent, current, live, connected, ws.mapArchitecture, ws.architecture.workflows, wb.selectedNode, wb.showPanel, wb.outlineOpen, theme, nav]);

  // Rows that carry the query itself.
  const q = query.trim();
  const ask = (quiet: boolean) => {
    if (!q) return;
    close();
    const running = daemon.turns.some((t) => !t.stopReason);
    if (running || !current || !live) {
      requestComposerDraft(q);
      wb.ask();
      return;
    }
    sendPrompt(wb.contextNode?.id ?? null, q);
    if (!quiet) wb.ask();
    else toast.message("Asked the agent", { description: q.length > 80 ? `${q.slice(0, 80)}…` : q });
  };
  const rows = useMemo<Row[]>(() => {
    if (!q) return baseRows;
    const dynamic: Row[] = [];
    if (current && live) {
      dynamic.push({
        id: "a:ask-query",
        group: "Actions",
        label: `Ask the agent: “${q}”`,
        sub: wb.contextNode ? `about ${wb.contextNode.label}` : "about this project",
        always: true,
        tile: <IconTile icon={Sparkles} className="text-ai" />,
        kbd: "Tab",
        run: () => ask(false),
        background: () => ask(true),
      });
      dynamic.push({
        id: "a:run-query",
        group: "Actions",
        label: `Run “${q}” in terminal`,
        sub: "project root",
        always: true,
        tile: <IconTile icon={SquareTerminal} />,
        run: () => {
          close();
          runInTerminal(q);
        },
      });
    }
    return [...baseRows.filter((r) => r.id !== "a:ask"), ...dynamic];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseRows, q, current, live, wb.contextNode]);

  const groups = useMemo(() => rankLauncher(rows, q), [rows, q]);
  const flat = useMemo(() => flattenRanked(groups), [groups]);
  const activeIndex = Math.min(active, Math.max(0, flat.length - 1));
  const activeRow = flat[activeIndex];

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
    clearTimeout(prefetchTimer.current);
    const pf = activeRow?.prefetch;
    if (pf) prefetchTimer.current = setTimeout(pf, 90);
  }, [activeIndex, activeRow]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setActive(moveActive(flat.length, activeIndex, delta));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!activeRow) return;
      if ((e.metaKey || e.ctrlKey) && activeRow.background) activeRow.background();
      else activeRow.run();
    } else if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      if (q && current && live) ask(false);
    }
  };

  let index = -1;
  return (
    <div className="flex max-h-[min(76vh,600px)] min-w-0 flex-col">
      <label className="flex h-14 shrink-0 items-center gap-2.5 border-b border-hairline px-4">
        <Search className="size-4.5 shrink-0 text-muted-foreground" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search projects, chats, elements, cloud, actions…"
          aria-label="Search Ruah"
          role="combobox"
          aria-expanded
          aria-controls="launcher-list"
          aria-activedescendant={activeRow ? `launcher-${activeRow.id}` : undefined}
          className="h-full min-w-0 flex-1 bg-transparent text-[16px] text-foreground outline-none placeholder:text-faint"
        />
        {current && live ? (
          <span className="flex shrink-0 items-center gap-1 text-meta text-muted-foreground">
            <kbd className="kbd">Tab</kbd> ask agent
          </span>
        ) : null}
      </label>
      <div ref={listRef} id="launcher-list" role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
        {flat.length === 0 ? (
          <p className="px-3 py-10 text-center text-ui-sm text-muted-foreground">
            Nothing matches.{current && live ? " Press Tab to ask the agent instead." : ""}
          </p>
        ) : (
          groups.map((g) => (
            <div key={g.group} role="group" aria-label={g.group}>
              <div className="section-label px-2.5 pt-2.5 pb-1 uppercase tracking-[0.08em]">{g.group}</div>
              {g.items.map((r) => {
                index += 1;
                const i = index;
                const selected = i === activeIndex;
                return (
                  <button
                    key={r.id}
                    id={`launcher-${r.id}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-index={i}
                    tabIndex={-1}
                    onMouseMove={() => i !== activeIndex && setActive(i)}
                    onClick={(e) => ((e.metaKey || e.ctrlKey) && r.background ? r.background() : r.run())}
                    className={cn(
                      "flex h-[38px] w-full items-center gap-2.5 rounded-lg px-2.5 text-left",
                      selected ? "bg-accent" : "hover:bg-accent/50",
                    )}
                  >
                    {r.tile}
                    <span className="shrink-0 truncate text-[13.5px] text-foreground max-w-[55%]">{r.label}</span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{r.sub}</span>
                    {r.badge ? (
                      <span className={cn("shrink-0 rounded-full px-2 py-px text-[11px]", badgeTone[r.badge.tone])}>{r.badge.label}</span>
                    ) : null}
                    {r.kbd ? <kbd className="kbd shrink-0">{r.kbd}</kbd> : null}
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>
      <div className="flex h-[38px] shrink-0 items-center gap-4 border-t border-hairline px-4 text-meta text-muted-foreground">
        <span>↑↓ move</span>
        <span>↵ open</span>
        {activeRow?.background ? <span>⌘↵ in background</span> : null}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => {
            close();
            setShellDialog("shortcuts", true);
          }}
          className="flex items-center gap-1 rounded px-1 hover:text-foreground"
        >
          <Keyboard className="size-3.5" /> Shortcuts
        </button>
        <span>esc</span>
      </div>
    </div>
  );
}
