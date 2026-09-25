import { createFileRoute } from "@tanstack/react-router";
import { AgentLimitsPage } from "@/components/usage/AgentLimitsPage";

export const Route = createFileRoute("/limits")({
  head: () => ({ meta: [{ title: "Limits · Ruah" }] }),
  component: AgentLimitsPage,
});
