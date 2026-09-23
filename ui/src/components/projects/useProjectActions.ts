// Project actions shared by the start screen, the ⌘K palette and the sidebar switcher:
// every entry point opens projects the same way and reports failures as toasts.
import { useCallback, useMemo } from "react";
import { useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import type { ProjectInfo, RecentChat } from "@/lib/contracts";
import {
  basename,
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

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

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
          description: "Start the Ruah app (or `archmap serve`) to open projects.",
        });
        return false;
      }
      closeOverlays();
      try {
        await openProject(path, { ...(name ? { name } : {}), ...(projectId ? { projectId } : {}) });
        return true;
      } catch (err) {
        toast.error(`Couldn't open ${name ?? basename(path)}`, { description: message(err) });
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

  /** Show the conversation: the Map's side panel, else the Agent page. */
  const revealChat = useCallback(() => {
    const pathname = router.state.location.pathname;
    if (pathname === "/map") {
      // setPanelView also shows the side panel when it was hidden.
      wb.setPanelView("agent");
      wb.setSheetOpen(true);
    } else if (pathname !== "/agent") void router.navigate({ to: "/agent" });
  }, [router, wb]);

  const startChat = useCallback(() => {
    closeOverlays();
    if (newChat()) revealChat();
  }, [closeOverlays, revealChat]);

  /** Open a chat (from any project) and show it. */
  const showChat = useCallback(
    async (
      chat: Pick<RecentChat, "id" | "projectId" | "projectRoot" | "projectName"> | { id: string; projectId: string },
    ) => {
      closeOverlays();
      revealChat();
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
