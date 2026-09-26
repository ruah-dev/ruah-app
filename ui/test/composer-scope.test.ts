// Regression: the composer's unsent text and images stayed in place across a project switch, so a
// question typed for one client's repo was sent (Enter) to the next project's agent, and an image
// uploaded into one project failed as "attachment not found" when sent from another. The composer
// is now one per project (remounted on a switch) and parks each project's draft and images.
// No DOM test environment here: this guards the wiring statically, the parking is in the sources.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");

describe("composer drafts belong to a project", () => {
  it("AgentPanel remounts the composer per project and tells it which one", () => {
    const panel = read("components/agent/AgentPanel.tsx");
    const composer = /<Composer\b[\s\S]*?\/>/.exec(panel)?.[0] ?? "";
    expect(composer).toMatch(/key=\{daemon\.project\?\.id\b/);
    expect(composer).toMatch(/scope=\{daemon\.project\?\.id\}/);
  });

  it("the composer parks its text and images under that project", () => {
    const src = read("components/agent/Composer.tsx");
    expect(src).toMatch(/parkedDrafts\.get\(scope\)/);
    expect(src).toMatch(/useComposerAttachments\(scope\)/);
    const attachments = read("components/agent/Attachments.tsx");
    expect(attachments).toMatch(/parkedAttachments\.set\(parkKey/);
  });
});
