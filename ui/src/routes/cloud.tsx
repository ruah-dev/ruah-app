import { createFileRoute } from "@tanstack/react-router";
import { CloudPage } from "@/components/cloud/CloudPage";

export const Route = createFileRoute("/cloud")({
  head: () => ({ meta: [{ title: "Cloud · Ruah" }] }),
  component: CloudPage,
});
