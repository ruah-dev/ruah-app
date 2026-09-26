// ui/test/new-project.test.ts — the new project wizard's rules (ui/src/lib/new-project.ts): names,
// the final path, the exact `gh repo create` command, when a step can advance, what is sent.
import { describe, expect, it } from "vitest";
import type { NewProjectCheck, TemplateInfo } from "@/lib/contracts";
import {
  canAdvance,
  checkKey,
  createInput,
  createsPath,
  currentCheck,
  defaultPrompt,
  ghCommand,
  initialWizard,
  joinPath,
  locationNote,
  nameProblem,
  pathMessage,
  repoNameFor,
  setupStatus,
  slugify,
} from "@/lib/new-project";

const ok: NewProjectCheck = { path: "/p/x", ok: true, name: { ok: true }, parent: { exists: true, isDir: true, writable: true }, target: { exists: false }, problems: [] };

describe("new project wizard", () => {
  it("validates names like the daemon", () => {
    expect(nameProblem("")).toBeNull();
    expect(nameProblem("payments api")).toBeNull();
    expect(nameProblem("a/b")).toMatch(/slashes/);
    expect(nameProblem(".env")).toMatch(/hidden/);
    expect(nameProblem("what?")).toMatch(/letters/);
    expect(nameProblem("..")).toMatch(/real name/);
  });

  it("joins the path and derives the GitHub command it would run", () => {
    expect(joinPath("~/Projects/", " shop ")).toBe("~/Projects/shop");
    expect(joinPath("~/Projects", "")).toBe("~/Projects");
    expect(slugify("Payments API")).toBe("payments-api");
    const s = { ...initialWizard("~/Projects"), name: "Payments API" };
    expect(repoNameFor(s)).toBe("payments-api");
    expect(ghCommand(s)).toBe("gh repo create payments-api --private --source . --remote origin --push");
    expect(ghCommand({ ...s, visibility: "public", commit: false, repoName: "pay" })).toBe("gh repo create pay --public --source . --remote origin");
    // No git identity: the daemon skips the first commit, so the command it runs has no --push.
    expect(ghCommand(s, false)).toBe("gh repo create payments-api --private --source . --remote origin");
  });

  it("never accepts a repository name gh would read as a flag", () => {
    const s = { ...initialWizard("~/Projects"), name: "shop", github: true };
    for (const bad of ["--public", "-h", "-x"]) expect(canAdvance(2, { ...s, repoName: bad }, ok), bad).toBe(false);
    expect(canAdvance(2, { ...s, repoName: ".github" }, ok)).toBe(true);
  });

  it("shows the folder the daemon resolves, and never a check for an older input", () => {
    const s = { ...initialWizard("Projects"), name: "Delta" };
    const resolved: NewProjectCheck = { ...ok, path: "/Users/me/Projects/Delta", parent: { path: "/Users/me/Projects", exists: true, isDir: true, writable: true } };
    expect(createsPath(null, s, "/Users/me")).toBe("Projects/Delta");
    expect(createsPath(resolved, s, "/Users/me")).toBe("~/Projects/Delta");
    expect(createsPath(resolved, s, undefined)).toBe("/Users/me/Projects/Delta");
    expect(createsPath({ ...resolved, name: { ok: false, error: "x" } }, s, "/Users/me")).toBe("Projects/Delta");
    // The debounce: the answer for "~/Projects" + "Delta" says nothing about "Projects" + "Delta".
    const stored = { key: checkKey({ parentDir: "~/Projects", name: "Delta" }), check: ok };
    expect(currentCheck(stored, { parentDir: "~/Projects", name: " Delta " })).toBe(ok);
    expect(currentCheck(stored, s)).toBeNull();
    expect(canAdvance(0, s, currentCheck(stored, s))).toBe(false);
  });

  it("never says the agent is setting it up before the prompt went out to a working agent", () => {
    const asked = { askedAgent: true, promptSent: false, pending: true, agentState: "starting" };
    expect(setupStatus({ ...asked, askedAgent: false })).toBe("none");
    expect(setupStatus(asked)).toBe("waiting");
    expect(setupStatus({ ...asked, agentState: "error" })).toBe("blocked");
    expect(setupStatus({ ...asked, agentState: "stopped" })).toBe("blocked");
    expect(setupStatus({ ...asked, pending: false })).toBe("lost"); // a reload dropped the queued prompt
    expect(setupStatus({ ...asked, promptSent: true, pending: false, agentState: "busy" })).toBe("working");
    expect(setupStatus({ ...asked, promptSent: true, pending: false, agentState: "error" })).toBe("error");
  });

  it("says “remembered” only for a remembered folder", () => {
    const d = { parentDir: "/Users/me/Projects", home: "/Users/me" };
    expect(locationNote({ ...d, parentSource: "remembered" }, "~/Projects")).toMatch(/^Remembered/);
    expect(locationNote({ ...d, parentSource: "projects" }, "~/Projects")).toMatch(/^Your Projects folder/);
    expect(locationNote({ ...d, parentSource: "home" }, "~/Projects")).not.toMatch(/Remembered/);
    expect(locationNote({ ...d }, "~/Projects")).toBeNull(); // an older daemon: nothing claimed
    expect(locationNote({ ...d, parentSource: "remembered" }, "~/Work")).toBeNull();
    expect(locationNote({ ...d, parentSource: "remembered" }, "Projects")).toMatch(/taken from your home folder/);
    expect(locationNote(null, "/abs")).toBeNull();
  });

  it("advances only with a valid, free location", () => {
    const s = { ...initialWizard("~/Projects"), name: "shop" };
    expect(canAdvance(0, s, null)).toBe(false);
    expect(canAdvance(0, s, ok)).toBe(true);
    expect(canAdvance(0, s, { ...ok, target: { exists: true, empty: true } })).toBe(false);
    const missing = { ...ok, parent: { exists: false, isDir: false, writable: true } };
    expect(canAdvance(0, s, missing)).toBe(false);
    expect(canAdvance(0, { ...s, createParent: true }, missing)).toBe(true);
    expect(canAdvance(0, { ...s, name: "a/b" }, ok)).toBe(false);
    expect(canAdvance(2, { ...s, github: true, git: false }, ok)).toBe(false);
    expect(canAdvance(2, { ...s, github: true, repoName: "bad name" }, ok)).toBe(false);
    expect(canAdvance(2, { ...s, github: true }, ok)).toBe(true);
  });

  it("sends only what was chosen; GitHub never without git", () => {
    const s = { ...initialWizard("~/Projects/"), name: " shop ", template: "web-vite-react" };
    expect(createInput(s)).toEqual({ parentDir: "~/Projects/", name: "shop", template: "web-vite-react", git: true, commit: true });
    expect(createInput({ ...s, github: true, visibility: "public", repoName: "shop-web", system: "/p/platform", createParent: true })).toEqual({
      parentDir: "~/Projects/", name: "shop", template: "web-vite-react", git: true, commit: true,
      github: { visibility: "public", name: "shop-web" }, system: "/p/platform", createParent: true,
    });
    expect(createInput({ ...s, github: true, git: false })).not.toHaveProperty("github");
    expect(createInput({ ...s, git: false }).commit).toBe(false);
  });

  it("explains the path and suggests a first prompt", () => {
    expect(pathMessage(null, { createParent: false }).text).toBe("Checking…");
    expect(pathMessage(ok, { createParent: false }).tone).toBe("ok");
    expect(pathMessage({ ...ok, target: { exists: true, empty: false } }, { createParent: false }).text).toMatch(/never writes into an existing folder/);
    expect(pathMessage({ ...ok, parent: { exists: false, isDir: false, writable: true } }, { createParent: false }).tone).toBe("warn");
    expect(pathMessage({ ...ok, parent: { exists: true, isDir: true, writable: false } }, { createParent: false }).tone).toBe("bad");
    const t: TemplateInfo = { id: "x", name: "X", description: "", files: [], setupPrompt: "Set up the project." };
    expect(defaultPrompt(t, "Shop")).toBe("Set up the project. The project is called “Shop”.");
  });
});
