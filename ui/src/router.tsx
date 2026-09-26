import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { registerPreview } from "./components/preview/register";
import { registerUsageLimits } from "./components/usage/register";

// The live preview joins the shell (top-bar Preview toggle and status chip, "Agent | Preview"
// on the right); the per-agent limits feed the agent pill's "N% left" and threshold toasts.
registerPreview();
registerUsageLimits();

export const getRouter = () => {
  const queryClient = new QueryClient();

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  });

  return router;
};
