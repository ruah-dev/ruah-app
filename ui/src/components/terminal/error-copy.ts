// What the "Couldn't open a terminal" toast says next, by what went wrong. Only a terminal that
// isn't connected to the daemon points at Ruah itself; a shell or folder error while the daemon
// is up says to try again, and "unavailable" already carries its reason (node-pty missing, a
// remote host). Pure; unit-tested in ui/test/page-states.test.ts.
import type { TerminalConnection } from "@/lib/terminal";

export function terminalErrorCopy(err: unknown, connection: TerminalConnection): string {
  const reason = (err instanceof Error ? err.message : String(err)).trim().replace(/\.$/, "") || "Unknown error";
  if (connection === "unavailable") return `${reason}.`;
  if (connection === "open") return `${reason}. Try again.`;
  return `${reason}. Check that Ruah is still running, then try again.`;
}
