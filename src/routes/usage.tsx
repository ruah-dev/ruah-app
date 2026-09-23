import { createFileRoute } from "@tanstack/react-router";
import { UsagePage } from "@/components/usage/UsagePage";

export const Route = createFileRoute("/usage")({
  head: () => ({ meta: [{ title: "Usage · Ruah" }] }),
  component: UsagePage,
});
