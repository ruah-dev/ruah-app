import { createFileRoute } from "@tanstack/react-router";
import { AgentPage } from "@/components/agent/AgentPage";

export const Route = createFileRoute("/agent")({
  head: () => ({ meta: [{ title: "Agent · Ruah" }] }),
  component: AgentPage,
});
