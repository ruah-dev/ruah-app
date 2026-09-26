// When the start screen and the "Getting started" card show (§20), as pure functions. Unit-tested
// in ui/test/start-screen.test.ts.
//
// Before: a fresh profile opened the start screen as an overlay on every page load — over an open
// project — until "Getting started" was skipped. Now the start screen shows only when no project is
// open (the daemon's launcher state) or when asked (⌘K → Start screen, Settings → Getting started);
// the card only on a true first run (nothing ever opened, or only the project that run opened —
// then it waits on the start screen behind a one-time toast); a reload never covers an open
// project; only dismissing the card marks the profile onboarded.

export type StartScreenMode = "none" | "launcher" | "overlay";

/** What covers the shell: the start screen as the page (no project), as an overlay (asked for), or nothing. */
export function startScreenMode(s: { projectsSupported: boolean; projectOpen: boolean; switching: boolean; launcherOpen: boolean }): StartScreenMode {
  if (s.switching) return "none";
  if (s.projectsSupported && !s.projectOpen) return "launcher";
  return s.launcherOpen ? "overlay" : "none";
}

export type OnboardVerdict = "show" | "offer" | "skip" | "wait";

/**
 * The first-run "Getting started" card:
 * - "show": a true first run with nothing open (never dismissed, the project list is empty) —
 *   the card sits on the start screen;
 * - "offer": a true first run that opened a project straight away (`ruah app ~/repo`: the list
 *   holds just that one) — the card waits on the start screen and a quiet toast points to it,
 *   nothing covers the project;
 * - "skip": dismissed before, or a profile that already has projects;
 * - "wait": until the list has loaded.
 * Only dismissing the card marks the profile onboarded — never a "skip" or an "offer".
 */
export function shouldOnboard(s: { onboarded: boolean; projectsLoaded: boolean; recentCount: number; projectOpen: boolean }): OnboardVerdict {
  if (s.onboarded) return "skip";
  if (!s.projectsLoaded) return "wait";
  if (s.projectOpen) return s.recentCount <= 1 ? "offer" : "skip";
  return s.recentCount === 0 ? "show" : "skip";
}

/**
 * What the onboarding rule sees. Without a daemon (the bundled sample) there is no list to wait
 * for and no project: a first run shows the card (the sample opens it over the start screen).
 */
export function onboardingInput(d: { source: "daemon" | "sample" | null; projectsLoaded: boolean; recentCount: number; projectOpen: boolean }, onboarded: boolean) {
  if (d.source === "sample") return { onboarded, projectsLoaded: true, recentCount: 0, projectOpen: false };
  return { onboarded, projectsLoaded: d.projectsLoaded, recentCount: d.recentCount, projectOpen: d.projectOpen };
}
