import { createFileRoute } from "@tanstack/react-router";
import { ExtensionsPage, type ExtensionsTab } from "@/components/extensions/ExtensionsPage";

const TABS: readonly ExtensionsTab[] = ["installed", "discover", "agents"];

// /extensions?tab=discover|agents opens a view directly (e.g. from a rail badge or the agent picker).
export const Route = createFileRoute("/extensions")({
  head: () => ({ meta: [{ title: "Extensions · Ruah" }] }),
  validateSearch: (search: Record<string, unknown>): { tab?: ExtensionsTab } => {
    const raw = search["tab"];
    const tab = typeof raw === "string" && (TABS as readonly string[]).includes(raw) ? (raw as ExtensionsTab) : undefined;
    return tab !== undefined ? { tab } : {};
  },
  component: ExtensionsRoute,
});

function ExtensionsRoute() {
  const { tab } = Route.useSearch();
  return <ExtensionsPage key={tab ?? "installed"} initialTab={tab ?? "installed"} />;
}
