// "Open in terminal" / "Run in terminal" entry points (node toolbar, Details, ⌘K, chat tool
// calls): the terminal store's actions plus an error toast.
import { toast } from "sonner";
import { openTerminalForElement, runInTerminal } from "@/lib/terminal";

function fail(err: unknown) {
  toast.error("Couldn't open a terminal", {
      description: `${(err instanceof Error ? err.message : String(err)).replace(/\.$/, "")}. Check that Ruah is still running, then try again.`,
    });
}

export function openElementInTerminal(node: { id: string; label?: string; path?: string; filePaths?: string[] }) {
  openTerminalForElement(node).catch(fail);
}

export function runCommandInTerminal(command: string) {
  runInTerminal(command).catch(fail);
}
