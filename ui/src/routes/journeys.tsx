import { createFileRoute } from "@tanstack/react-router";
import { JourneysPage, type JourneysSearch, type JourneysView } from "@/components/journeys/JourneysPage";

const VIEWS: readonly JourneysView[] = ["line", "map"];
const ID = /^(?:[a-z0-9][a-z0-9-]{0,62}:)?[a-z0-9][a-z0-9._-]{0,63}$/;

// /journeys?journey=pay-rent&step=send&view=map opens a journey step directly (the Map's element
// inspector, the launcher, notifications).
export const Route = createFileRoute("/journeys")({
  head: () => ({ meta: [{ title: "Journeys · Ruah" }] }),
  validateSearch: (search: Record<string, unknown>): JourneysSearch => {
    const out: JourneysSearch = {};
    const journey = search["journey"];
    const step = search["step"];
    const view = search["view"];
    if (typeof journey === "string" && ID.test(journey)) out.journey = journey;
    if (typeof step === "string" && ID.test(step)) out.step = step;
    if (typeof view === "string" && (VIEWS as readonly string[]).includes(view)) out.view = view as JourneysView;
    return out;
  },
  component: JourneysRoute,
});

function JourneysRoute() {
  const search = Route.useSearch();
  return <JourneysPage search={search} />;
}
