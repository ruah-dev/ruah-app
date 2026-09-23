// Dev route /_ghosts: the Phantom expression sheet. Deliberately not in NAV.
import { createFileRoute } from "@tanstack/react-router";
import { GhostSheet } from "@/components/brand/GhostSheet";

export const Route = createFileRoute("/_ghosts")({
  head: () => ({ meta: [{ title: "Ghosts · Ruah" }] }),
  component: GhostSheet,
});
