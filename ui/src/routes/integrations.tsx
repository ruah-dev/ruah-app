import { createFileRoute } from "@tanstack/react-router";
import { IntegrationsPage } from "@/components/integrations/IntegrationsPage";

export const Route = createFileRoute("/integrations")({
  head: () => ({ meta: [{ title: "Integrations · Ruah" }] }),
  component: IntegrationsPage,
});
