// ui/test/start-screen.test.ts — when the start screen and the first-run card show
// (ui/src/lib/start-screen.ts): never over an open project on load; the card only on a true first run.
import { describe, expect, it } from "vitest";
import { shouldOnboard, startScreenMode } from "@/lib/start-screen";

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
    expect(shouldOnboard({ ...fresh, projectOpen: true })).toBe("skip");
    expect(shouldOnboard({ ...fresh, onboarded: true })).toBe("skip");
  });
});
