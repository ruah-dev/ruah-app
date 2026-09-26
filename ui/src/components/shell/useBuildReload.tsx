// Picks up a newer viewer build while the window is open (the decision: lib/build-reload.ts).
// Asks the daemon which build it serves (GET /api/health `viewerBuild`) when the connection
// opens, when the window gets focus or becomes visible, and every 30 s (hidden too: a window in
// the background is the best moment for a silent reload). Differs →
// reload silently when nothing would be lost (no running turn, no typed text, no map edit, no
// open dialog, no image attached and unsent; the per-project view state restores the page, map
// level and panels), else say so: a short "Ruah was updated" toast at the top (away from the
// composer being typed in) and a calm "Update ready" chip in the top bar's status area until the
// reload (its tooltip says what holds the reload back, as of now). A prompted window still
// reloads by itself once it is in the background and idle, and drops the prompt if the daemon
// serves this window's build again (restarted with the previous viewer, a rollback). One reload
// per served build: never a loop.
import { useEffect, useRef } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  BUILD_ID,
  busyReasons,
  hasComposerPending,
  hasOpenOverlay,
  hasUnsavedInput,
  reloadAttempted,
  reloadDecision,
  reloadForBuild,
} from "@/lib/build-reload";
import type { DaemonState } from "@/lib/daemon";
import { useWorkspace } from "@/lib/workspace";
import { useWorkbench } from "@/lib/workbench";
import { registerStatusItem } from "./slots";
import { StatusChip } from "./StatusChips";

const POLL_MS = 30_000;
const TOAST_ID = "ruah-updated";
const CHIP_ID = "ruah-update";

/** What a reload would lose or interrupt right now (DOM checks included). */
function busyNow(daemon: DaemonState, editing: boolean): string[] {
  return busyReasons({
    turnRunning: daemon.turns.some((t) => !t.stopReason),
    unsavedInput: hasUnsavedInput(document),
    pendingAttachments: hasComposerPending(),
    mapEditing: editing || daemon.save === "pending" || daemon.save === "saving",
    dialogOpen: hasOpenOverlay(document),
  });
}

function reloadNow(served: string, projectId: string | null) {
  if (!reloadForBuild(served, 0, projectId)) window.location.reload();
}

/** The chip's tooltip line, computed when it shows (not when the chip was registered). */
function UpdateReasons() {
  const { daemon } = useWorkspace();
  const { editing } = useWorkbench();
  const reasons = busyNow(daemon, editing);
  return reasons.length ? <span className="block text-muted-foreground">Not reloaded by itself: {reasons.join(", ")}.</span> : null;
}

function UpdateChip({ served }: { served: string }) {
  const { daemon } = useWorkspace();
  return (
    <StatusChip
      icon={RefreshCw}
      label="Update ready"
      short="Update"
      ariaLabel="Ruah was updated: reload to use the new version"
      onClick={() => reloadNow(served, daemon.project?.id ?? null)}
      title={
        <>
          <span className="block">Ruah was updated. Click to reload.</span>
          <UpdateReasons />
          <span className="block text-muted-foreground">It reloads by itself once you are away and nothing would be lost.</span>
        </>
      }
    />
  );
}

export function useBuildReload() {
  const { daemon } = useWorkspace();
  const wb = useWorkbench();
  const latest = useRef({ daemon, editing: wb.editing });
  latest.current = { daemon, editing: wb.editing };
  const promptedFor = useRef<string | null>(null);
  const removeChip = useRef<(() => void) | null>(null);
  const checking = useRef(false);
  const runCheck = useRef<() => void>(() => {});

  useEffect(() => {
    if (!BUILD_ID || typeof window === "undefined") return;
    let stopped = false;

    const clearPrompt = () => {
      promptedFor.current = null;
      removeChip.current?.();
      removeChip.current = null;
      toast.dismiss(TOAST_ID);
    };

    const check = async () => {
      const { daemon } = latest.current;
      if (checking.current || stopped || daemon.source !== "daemon" || daemon.connection !== "open" || !daemon.httpOrigin) return;
      checking.current = true;
      let served: string | null = null;
      try {
        const r = await fetch(`${daemon.httpOrigin}/api/health`, { cache: "no-store" });
        const h = r.ok ? ((await r.json()) as { viewerBuild?: unknown }) : null;
        served = typeof h?.viewerBuild === "string" ? h.viewerBuild : null;
      } catch {
        served = null;
      } finally {
        checking.current = false;
      }
      if (stopped || !served) return;
      const { daemon: now, editing } = latest.current;
      const busy = busyNow(now, editing);
      const decision = reloadDecision({
        own: BUILD_ID,
        served,
        sameOrigin: window.location.origin === now.httpOrigin,
        busy: busy.length > 0,
        attempted: reloadAttempted(),
      });
      if (decision === "none") {
        // The daemon serves this window's build again (restarted with the previous viewer, a
        // rollback): nothing to reload for any more.
        if (served === BUILD_ID) clearPrompt();
        return;
      }
      const away = document.visibilityState === "hidden" || !document.hasFocus();
      // Silently when nothing is lost; after a prompt, only while the user looks elsewhere.
      if (decision === "reload" && (promptedFor.current !== served || away)) {
        toast.dismiss(TOAST_ID);
        reloadForBuild(served, 600, now.project?.id ?? null);
        return;
      }
      if (promptedFor.current === served) return;
      promptedFor.current = served;
      removeChip.current?.();
      removeChip.current = registerStatusItem({ id: CHIP_ID, order: 0, render: () => <UpdateChip served={served} /> });
      toast("Ruah was updated", {
        id: TOAST_ID,
        position: "top-center",
        description: busy.length ? `Reload when you are ready (${busy.join(", ")}).` : "Reload to use the new version.",
        duration: 10_000,
        action: { label: "Reload", onClick: () => reloadNow(served, latest.current.daemon.project?.id ?? null) },
      });
    };

    runCheck.current = () => void check();
    const onFocus = () => void check();
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(() => void check(), POLL_MS);
    return () => {
      stopped = true;
      runCheck.current = () => {};
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
      removeChip.current?.();
      removeChip.current = null;
    };
  }, []);

  // A (re)connected daemon may serve another build (the app was rebuilt and restarted).
  const connected = daemon.connection === "open" && daemon.source === "daemon";
  useEffect(() => {
    if (!connected || !BUILD_ID) return;
    // Let the first frames settle (turns, chats) before judging "busy".
    const t = setTimeout(() => runCheck.current(), 1500);
    return () => clearTimeout(t);
  }, [connected]);
}
