import { createFileRoute } from "@tanstack/react-router";
import { MapPage } from "@/components/map/MapPage";

export const Route = createFileRoute("/map")({
  head: () => ({ meta: [{ title: "Map · Ruah" }] }),
  component: MapPage,
});
