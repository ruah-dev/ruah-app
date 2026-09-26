import { createFileRoute } from "@tanstack/react-router";
import { DashboardPage } from "@/components/dashboard/DashboardPage";

// "/" = Home (every project, §20.5); "/?view=project" = the open project's dashboard.
export const Route = createFileRoute("/")({
  head: () => ({ meta: [{ title: "Ruah" }] }),
  validateSearch: (search: Record<string, unknown>): { view?: "project" } => (search["view"] === "project" ? { view: "project" } : {}),
  component: DashboardPage,
});
