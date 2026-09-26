// ui/test/new-project.test.ts — the new project wizard's rules (ui/src/lib/new-project.ts): names,
// the final path, the exact `gh repo create` command, when a step can advance, what is sent.
import { describe, expect, it } from "vitest";
import type { NewProjectCheck, TemplateInfo } from "@/lib/contracts";
import { canAdvance, createInput, defaultPrompt, ghCommand, initialWizard, joinPath, nameProblem, pathMessage, repoNameFor, slugify } from "@/lib/new-project";

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
