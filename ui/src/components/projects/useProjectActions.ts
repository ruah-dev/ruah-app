// Project actions shared by the start screen, the ⌘K palette and the sidebar switcher:
// every entry point opens projects the same way and reports failures as toasts.
import { useCallback, useMemo } from "react";
import { useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import type { ProjectInfo, RecentChat } from "@/lib/contracts";
import {
  basename,
  daemonSnapshot,
  forgetProject,
  newChat,
  openChat,
  openChatAnywhere,
  openProject,
  pinProject,
  type DaemonState,
} from "@/lib/daemon";
import { useWorkspace } from "@/lib/workspace";
import { useWorkbench } from "@/lib/workbench";
import { markChatIntent } from "@/components/shell/shellState";
import { confirmAction } from "@/lib/confirm";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The agent is working in the chat in front (a turn without a stop reason, maybe waiting for a permission). */
export function activeTurnRunning(daemon: Pick<DaemonState, "turns">): boolean {
  return daemon.turns.some((t) => !t.stopReason);
}

/**
 * Opening another chat of the same project (or a new one) stops a running turn (§5.2), unlike a
 * project switch, which keeps it running. Ask first instead of cancelling the agent's work
 * silently. Resolves true when the switch may go ahead.
 */
async function okToLeaveRunningChat(): Promise<boolean> {
  if (!activeTurnRunning(daemonSnapshot())) return true;
  return confirmAction({
    title: "Stop the agent?",
    description:
      "The agent is still working in this chat. Opening another chat of this project stops it (switching to another project keeps it running).",
    confirmLabel: "Stop and switch",
    destructive: true,
  });
}

export function canManageProjects(daemon: DaemonState) {
  return daemon.source !== "sample" && daemon.connection === "open" && !!daemon.httpOrigin;
}

export function useProjectActions() {
  const { daemon } = useWorkspace();
  const wb = useWorkbench();
  const router = useRouter();
  const connected = canManageProjects(daemon);

  const closeOverlays = useCallback(() => {
    wb.setLauncherOpen(false);
    wb.setPaletteOpen(false);
    wb.setMobileNavOpen(false);
  }, [wb]);

  const open = useCallback(
    async (path: string, name?: string, projectId?: string) => {
      if (!connected) {
        toast.error("No Ruah daemon connected", {
          description: "Start the Ruah app (or `ruah app serve`) to open projects.",
        });
        return false;
      }
      closeOverlays();
      try {
        await openProject(path, { ...(name ? { name } : {}), ...(projectId ? { projectId } : {}) });
        return true;
      } catch (err) {
        const label = name ?? basename(path);
        // A recent project whose folder was moved or deleted: offer to drop it from the list
        // (it stayed in the launcher, failing the same way on every click).
        const missing = projectId !== undefined && /folder not found|no such file|ENOENT/i.test(message(err));
        toast.error(`Couldn't open ${label}`, {
          description: missing ? `${message(err)} — moved or deleted? Remove it from the recent list, or open it again from its new place (⌘O).` : message(err),
          ...(missing
            ? {
                action: {
                  label: "Remove from recents",
                  onClick: () =>
                    void forgetProject(projectId).then(
                      () => toast(`Removed ${label} from recent projects`, { description: "The folder itself is untouched." }),
                      (e: unknown) => toast.error(`Couldn't remove ${label}`, { description: message(e) }),
                    ),
                },
              }
            : {}),
        });
        return false;
      }
    },
    [connected, closeOverlays],
  );

  const openRecent = useCallback((p: ProjectInfo) => open(p.root, p.name, p.id), [open]);

  /** Desktop: native folder picker. Browser: the path dialog. */
  const pickFolder = useCallback(async () => {
    const bridge = typeof window !== "undefined" ? window.ruah : undefined;
    if (!bridge) {
      wb.setPaletteOpen(false);
      wb.setOpenFolderOpen(true);
      return;
    }
    const path = await bridge.pickFolder({ title: "Open a project folder" }).catch(() => null);
    if (path) await open(path);
  }, [open, wb]);

  const newProject = useCallback(() => {
    wb.setPaletteOpen(false);
    wb.setNewProjectOpen(true);
  }, [wb]);

  const togglePin = useCallback(async (p: ProjectInfo) => {
    try {
      await pinProject(p.id, !p.pinned);
    } catch (err) {
      toast.error(`Couldn't ${p.pinned ? "unpin" : "pin"} ${p.name}`, { description: message(err) });
    }
  }, []);

  const forget = useCallback(async (p: ProjectInfo) => {
    try {
      await forgetProject(p.id);
      toast(`${p.name} removed from recent projects`, {
        description: "The folder itself is untouched.",
      });
    } catch (err) {
      toast.error(`Couldn't remove ${p.name}`, { description: message(err) });
    }
  }, []);

  /** Show the conversation: the agent panel on the Map (or wherever it is open), else the
   * Agent page. */
  const revealChat = useCallback(() => {
    const pathname = router.state.location.pathname;
    if (pathname === "/agent") return;
    if (pathname === "/map" || (wb.showPanel && pathname !== "/chats")) {
      // setPanelView also shows the side panel when it was hidden.
      wb.setPanelView("agent");
      wb.setSheetOpen(true);
    } else void router.navigate({ to: "/agent" });
  }, [router, wb]);

  const startChat = useCallback(() => {
    closeOverlays();
    void okToLeaveRunningChat().then((ok) => {
      if (ok && newChat()) revealChat();
    });
  }, [closeOverlays, revealChat]);

  /** Open a chat (from any project) and show it. */
  const showChat = useCallback(
    async (
      chat: Pick<RecentChat, "id" | "projectId" | "projectRoot" | "projectName"> | { id: string; projectId: string },
    ) => {
      closeOverlays();
      const sameProject = chat.projectId === daemonSnapshot().project?.id;
      if (sameProject && chat.id !== daemonSnapshot().activeChatId && !(await okToLeaveRunningChat())) return;
      revealChat();
      // The switch shows this chat: the project's saved page is not restored over it.
      if (!sameProject) markChatIntent(chat.projectId);
      try {
        if ("projectRoot" in chat) await openChatAnywhere(chat);
        else openChat(chat.id);
      } catch (err) {
        toast.error("Couldn't open that chat", { description: message(err) });
      }
    },
    [closeOverlays, revealChat],
  );

  return useMemo(
    () => ({
      connected,
      open,
      openRecent,
      pickFolder,
      newProject,
      togglePin,
      forget,
      showChat,
      startChat,
    }),
    [connected, open, openRecent, pickFolder, newProject, togglePin, forget, showChat, startChat],
  );
}
