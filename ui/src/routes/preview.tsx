import { createFileRoute } from "@tanstack/react-router";
import { PreviewPage } from "@/components/preview/PreviewPage";

export const Route = createFileRoute("/preview")({
  head: () => ({ meta: [{ title: "Preview · Ruah" }] }),
  component: PreviewPage,
});
