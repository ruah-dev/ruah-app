// "Open in terminal" / "Run in terminal" entry points (node toolbar, Details, ⌘K, chat tool
// calls): the terminal store's actions plus an error toast.
import { toast } from "sonner";
import { openTerminalForElement, runInTerminal, terminalState } from "@/lib/terminal";
import { terminalErrorCopy } from "./error-copy";

function fail(err: unknown) {
  toast.error("Couldn't open a terminal", { description: terminalErrorCopy(err, terminalState().connection) });
}

export function openElementInTerminal(node: { id: string; label?: string; path?: string; filePaths?: string[] }) {
  openTerminalForElement(node).catch(fail);
}

export function runCommandInTerminal(command: string) {
  runInTerminal(command).catch(fail);
}
