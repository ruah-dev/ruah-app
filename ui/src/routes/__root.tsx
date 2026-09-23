import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { WorkspaceProvider } from "@/lib/workspace";
import { WorkbenchProvider } from "@/lib/workbench";
import { applyPalette, applyTheme, readPalette, readTheme, useColorScheme } from "@/lib/theme";
import { Phantom } from "@/components/brand/RuahLogo";
import { AppShell } from "@/components/shell/AppShell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="flex max-w-md flex-col items-center text-center">
        <Phantom size={64} expression="idle" />
        <p className="eyebrow mt-6">404</p>
        <h1 className="heading mt-2 text-[24px] text-foreground">Page not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="flex max-w-md flex-col items-center text-center">
        <Phantom size={64} expression="error" float={false} />
        <h1 className="heading mt-6 text-[22px] text-foreground">
          This page didn&apos;t load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-lg border border-hairline bg-surface-1 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Ruah" },
      {
        name: "description",
        content:
          "Ruah maps a codebase from services down to files, with workflows and a coding agent on every element.",
      },
      { name: "application-name", content: "Ruah" },
      { name: "theme-color", content: "#20201e" },
      { name: "color-scheme", content: "light dark" },
      { property: "og:site_name", content: "Ruah" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      { rel: "icon", href: "/icon.svg", type: "image/svg+xml" },
      { rel: "alternate icon", href: "/favicon.ico", type: "image/x-icon" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

// Mirrors lib/theme.ts (applyTheme + applyPalette) so the first paint has the saved theme.
const THEME_BOOT = `try{var p=localStorage.getItem("ruah.theme")||"dark";var m=p==="system"?(matchMedia("(prefers-contrast: more)").matches?"contrast":matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"):p;if(["dark","light","contrast"].indexOf(m)<0)m="dark";var s=m==="light"?"light":"dark";var r=document.documentElement;r.classList.remove("light","dark");r.classList.add(s);r.dataset.theme=m;r.style.colorScheme=s;var a=localStorage.getItem("ruah.palette");if(a==="dusk"||a==="sunrise")r.dataset.palette=a}catch(e){}`;

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark" data-theme="dark" suppressHydrationWarning>
      <head>
        {/* Apply the saved theme before first paint (no flash of the wrong theme). */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  useEffect(() => {
    applyTheme(readTheme());
    applyPalette(readPalette());
  }, []);
  const scheme = useColorScheme();

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={250}>
        <WorkspaceProvider>
          <WorkbenchProvider>
            <AppShell>
              {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
              <Outlet />
            </AppShell>
          </WorkbenchProvider>
        </WorkspaceProvider>
        <Toaster position="bottom-right" theme={scheme} closeButton />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
