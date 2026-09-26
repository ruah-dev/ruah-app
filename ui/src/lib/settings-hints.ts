// Settings → Integrations: the "Connected services" hint says what is connected right now.
// Pure; unit-tested in ui/test/settings-hints.test.ts.
import type { IntegrationInfo } from "./contracts";

/** "DigitalOcean, GitHub connected", "Nothing connected yet", or the generic list while loading. */
export function connectedServicesHint(list: readonly Pick<IntegrationInfo, "name" | "status">[] | null): string {
  if (list === null) return "Cloud providers, Jira, GitHub and ruah";
  const connected = list.filter((i) => i.status === "connected").map((i) => i.name);
  if (connected.length === 0) return "Nothing connected yet — cloud providers, Jira, GitHub and ruah";
  const shown = connected.slice(0, 4).join(", ");
  return `${shown}${connected.length > 4 ? ` and ${connected.length - 4} more` : ""} connected`;
}
