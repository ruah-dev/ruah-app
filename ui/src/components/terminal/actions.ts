// "Open in terminal" / "Run in terminal" entry points (node toolbar, Details, ⌘K, chat tool
// calls): the terminal store's actions plus an error toast.
import { toast } from "sonner";
import { openTerminalForElement, runInTerminal } from "@/lib/terminal";

function fail(err: unknown) {
  toast.error("Could not open a terminal", { description: err instanceof Error ? err.message : String(err) });
}

export function openElementInTerminal(node: { id: string; label?: string; path?: string; filePaths?: string[] }) {
  openTerminalForElement(node).catch(fail);
}

export function runCommandInTerminal(command: string) {
  runInTerminal(command).catch(fail);
}
