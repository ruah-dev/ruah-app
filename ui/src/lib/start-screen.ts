// When the start screen and the "Getting started" card show (§20), as pure functions. Unit-tested
// in ui/test/start-screen.test.ts.
//
// Before: a fresh profile opened the start screen as an overlay on every page load — over an open
// project — until "Getting started" was skipped. Now the start screen shows only when no project is
// open (the daemon's launcher state) or when asked (⌘K → Start screen, Settings → Getting started);
// the card only on a true first run (nothing ever opened); a reload never covers an open project.

export type StartScreenMode = "none" | "launcher" | "overlay";

/** What covers the shell: the start screen as the page (no project), as an overlay (asked for), or nothing. */
export function startScreenMode(s: { projectsSupported: boolean; projectOpen: boolean; switching: boolean; launcherOpen: boolean }): StartScreenMode {
  if (s.switching) return "none";
  if (s.projectsSupported && !s.projectOpen) return "launcher";
  return s.launcherOpen ? "overlay" : "none";
}

/**
 * The first-run "Getting started" card: "show" on a true first run (never dismissed, the project
 * list has loaded and is empty, no project open), "skip" otherwise (a profile with projects counts
 * as onboarded), "wait" until the list has loaded.
 */
export function shouldOnboard(s: { onboarded: boolean; projectsLoaded: boolean; recentCount: number; projectOpen: boolean }): "show" | "skip" | "wait" {
  if (s.onboarded || s.projectOpen) return "skip";
  if (!s.projectsLoaded) return "wait";
  return s.recentCount === 0 ? "show" : "skip";
}
