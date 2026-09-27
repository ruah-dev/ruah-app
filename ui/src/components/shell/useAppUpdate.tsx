// Keeps the installed app on the newest commit (daemon: src/desktop/self-update.ts; the store and
// the decision: lib/app-update.ts). Polls the daemon's status every minute, on focus and when the
// window shows. A staged update restarts the app by itself while the user is away and nothing
// would be lost (the same "busy" as a viewer reload, plus any running turn the daemon knows of);
// otherwise an "Update ready" chip and one toast per commit offer "Restart". It also installs
// when Ruah quits.
import { useEffect, useRef } from "react";
import { Download } from "lucide-react";
import { toast } from "sonner";
import {
  busyReasons,
  hasComposerPending,
  hasOpenOverlay,
  hasUnsavedInput,
} from "@/lib/build-reload";
import { describeUpdate, fetchAppUpdate, postAppUpdate, restartDecision, type AppUpdateStatus } from "@/lib/app-update";
import type { DaemonState } from "@/lib/daemon";
import { useWorkspace } from "@/lib/workspace";
import { useWorkbench } from "@/lib/workbench";
import { registerStatusItem } from "./slots";
import { StatusChip } from "./StatusChips";

const POLL_MS = 60_000;
const TOAST_ID = "ruah-app-update";
const CHIP_ID = "ruah-app-update";

function busyNow(daemon: DaemonState, editing: boolean): string[] {
  return busyReasons({
    turnRunning: daemon.turns.some((t) => !t.stopReason),
    unsavedInput: hasUnsavedInput(document),
    pendingAttachments: hasComposerPending(),
    mapEditing: editing || daemon.save === "pending" || daemon.save === "saving",
    dialogOpen: hasOpenOverlay(document),
  });
}

/** Asks the daemon to restart into the staged build; says why when it refuses. */
export async function restartToUpdate(origin: string, force = false): Promise<void> {
  const r = await postAppUpdate(origin, "install", force ? { force: true } : {});
  if (r.ok) {
    toast("Restarting Ruah to update…", { id: TOAST_ID, position: "top-center", duration: 8000 });
    return;
  }
  if (r.busy) {
    toast("An agent is still working", {
      id: TOAST_ID,
      position: "top-center",
      description: "Restarting now stops it. Ruah also updates when you quit it.",
      duration: 10_000,
      action: { label: "Restart anyway", onClick: () => void restartToUpdate(origin, true) },
    });
    return;
  }
  toast.error("Could not restart to update", { id: TOAST_ID, description: r.error ?? "unknown error" });
}

function UpdateChip({ status, origin }: { status: AppUpdateStatus; origin: string }) {
  return (
    <StatusChip
      icon={Download}
      label="Update ready"
      short="Update"
      ariaLabel="A new Ruah build is ready: restart to use it"
      onClick={() => void restartToUpdate(origin)}
      title={
        <>
          <span className="block">New build ready: {describeUpdate(status)}.</span>
          <span className="block">Click to restart Ruah into it.</span>
          <span className="block text-muted-foreground">It restarts by itself once you are away and nothing is running, and installs when you quit.</span>
        </>
      }
    />
  );
}

export function useAppUpdate() {
  const { daemon } = useWorkspace();
  const wb = useWorkbench();
  const latest = useRef({ daemon, editing: wb.editing });
  latest.current = { daemon, editing: wb.editing };
  const promptedFor = useRef<string | null>(null);
  const removeChip = useRef<(() => void) | null>(null);
  const restarting = useRef(false);

  const connected = daemon.source === "daemon" && daemon.connection === "open" && !!daemon.httpOrigin;
  const origin = daemon.httpOrigin;

  useEffect(() => {
    if (!connected || !origin || typeof window === "undefined") return;
    let stopped = false;

    const clearPrompt = () => {
      promptedFor.current = null;
      removeChip.current?.();
      removeChip.current = null;
    };

    const check = async () => {
      const status = await fetchAppUpdate(origin);
      if (stopped || !status) return;
      if (status.phase !== "ready") {
        if (status.phase !== "installing") clearPrompt();
        return;
      }
      const { daemon: now, editing } = latest.current;
      const busy = busyNow(now, editing);
      const away = document.visibilityState === "hidden" || !document.hasFocus();
      const decision = restartDecision({ phase: status.phase, auto: status.auto, away, busy: busy.length > 0 });
      if (decision === "restart" && !restarting.current) {
        restarting.current = true;
        // The daemon refuses (409) while a turn runs anywhere; then it is offered instead.
        const r = await postAppUpdate(origin, "install");
        restarting.current = r.ok;
        if (r.ok) return;
      }
      if (promptedFor.current === status.latest) return;
      promptedFor.current = status.latest ?? "";
      removeChip.current?.();
      removeChip.current = registerStatusItem({ id: CHIP_ID, order: 0, render: () => <UpdateChip status={status} origin={origin} /> });
      toast("A new Ruah build is ready", {
        id: TOAST_ID,
        position: "top-center",
        description: `${describeUpdate(status)}. Restart to use it — or it installs when you quit.`,
        duration: 12_000,
        action: { label: "Restart", onClick: () => void restartToUpdate(origin) },
      });
    };

    const onFocus = () => void check();
    const onVisible = () => void check();
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    const first = setTimeout(() => void check(), 2000);
    const timer = setInterval(() => void check(), POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      clearPrompt();
    };
  }, [connected, origin]);
}
