// ui/test/start-screen.test.ts — when the start screen and the first-run card show
// (ui/src/lib/start-screen.ts): never over an open project on load; the card only on a true first run.
import { describe, expect, it } from "vitest";
import { onboardingInput, shouldOnboard, startScreenMode } from "@/lib/start-screen";

describe("start screen", () => {
  it("covers the shell only without a project, or when asked", () => {
    const base = { projectsSupported: true, projectOpen: true, switching: false, launcherOpen: false };
    expect(startScreenMode(base)).toBe("none");
    expect(startScreenMode({ ...base, projectOpen: false })).toBe("launcher");
    expect(startScreenMode({ ...base, launcherOpen: true })).toBe("overlay");
    expect(startScreenMode({ ...base, projectOpen: false, switching: true })).toBe("none");
    // No daemon yet (the page just loaded): nothing covers the shell.
    expect(startScreenMode({ ...base, projectsSupported: false, projectOpen: false })).toBe("none");
  });

  it("shows Getting started only on a true first run", () => {
    const fresh = { onboarded: false, projectsLoaded: true, recentCount: 0, projectOpen: false };
    expect(shouldOnboard(fresh)).toBe("show");
    expect(shouldOnboard({ ...fresh, projectsLoaded: false })).toBe("wait");
    expect(shouldOnboard({ ...fresh, recentCount: 2 })).toBe("skip");
    expect(shouldOnboard({ ...fresh, onboarded: true })).toBe("skip");
    expect(shouldOnboard({ ...fresh, onboarded: true, projectOpen: true, recentCount: 1 })).toBe("skip");
  });

  it("offers the card (never covering the project) when the very first run opened a repo", () => {
    const fresh = { onboarded: false, projectsLoaded: true, recentCount: 1, projectOpen: true };
    // `ruah app ~/repo` on a new machine: the list holds only that repo.
    expect(shouldOnboard(fresh)).toBe("offer");
    expect(shouldOnboard({ ...fresh, recentCount: 0 })).toBe("offer");
    // A profile that has been used: nothing to offer.
    expect(shouldOnboard({ ...fresh, recentCount: 3 })).toBe("skip");
    expect(shouldOnboard({ ...fresh, projectsLoaded: false })).toBe("wait");
  });

  it("never waits forever without a daemon (the bundled sample)", () => {
    const sample = onboardingInput({ source: "sample", projectsLoaded: false, recentCount: 0, projectOpen: false }, false);
    expect(shouldOnboard(sample)).toBe("show");
    expect(shouldOnboard(onboardingInput({ source: "sample", projectsLoaded: false, recentCount: 0, projectOpen: false }, true))).toBe("skip");
    // Still connecting: wait for the list.
    expect(shouldOnboard(onboardingInput({ source: null, projectsLoaded: false, recentCount: 0, projectOpen: false }, false))).toBe("wait");
  });
});
