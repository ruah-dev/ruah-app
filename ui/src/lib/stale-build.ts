// A rebuilt viewer (`pnpm ui:build` while the app is open) replaces the hashed route chunks: the
// open page still asks for the old file names, so every page not visited yet fails to load
// ("Failed to fetch dynamically imported module"). Reload once to pick up the new build; a second
// failure within a minute is a real error and is shown instead of looping.
const KEY = "ruah.staleBuildReload";
const WINDOW_MS = 60_000;

export function isStaleChunkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(
    message,
  );
}

/** Reloads the page unless it already did so in the last minute; true = a reload is under way. */
export function reloadForNewBuild(): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? 0);
    if (Date.now() - last < WINDOW_MS) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

/** Vite fires vite:preloadError when a lazy chunk (or its CSS) cannot be fetched. */
export function installStaleBuildRecovery(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("vite:preloadError", (event) => {
    if (reloadForNewBuild()) event.preventDefault();
  });
}
