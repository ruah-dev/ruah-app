import { describe, expect, it } from "vitest";
import { cardText, chipPad, edgeLabelScale, isQuietEdgeKind, subtitleParts } from "@/components/editor/canvas/display";

describe("map card text", () => {
  it("shows what differs for IaC elements named '<Tool>: <what>' and keeps the full name", () => {
    expect(cardText({ label: "Kubernetes: prod", subtitle: "Kubernetes" })).toEqual({
      title: "prod",
      subtitle: "Kubernetes",
      full: "Kubernetes: prod",
    });
    expect(cardText({ label: "CI/CD: GitHub Actions", subtitle: "CI/CD" }).title).toBe("GitHub Actions");
    expect(cardText({ label: "Terraform: AWS", subtitle: "Terraform · AWS" })).toMatchObject({
      title: "AWS",
      subtitle: "Terraform · AWS",
    });
  });

  it("uses the tech list when the subtitle is something else", () => {
    expect(cardText({ label: "Helm: api", subtitle: "deploy/charts/api", tech: ["Helm"] })).toEqual({
      title: "api",
      subtitle: "deploy/charts/api",
      full: "Helm: api",
    });
    expect(cardText({ label: "Helm: api", tech: ["Helm"] })).toMatchObject({ title: "api", subtitle: "Helm" });
  });

  it("leaves every other name alone", () => {
    expect(cardText({ label: "api", subtitle: "TypeScript · Express 4" })).toEqual({
      title: "api",
      subtitle: "TypeScript · Express 4",
      full: "api",
    });
    // A colon that is not a tool prefix (no matching subtitle / tech).
    expect(cardText({ label: "Note: read me", subtitle: "docs" }).title).toBe("Note: read me");
    expect(cardText({ label: "http://localhost:8080", subtitle: "http" }).title).toBe("http://localhost:8080");
  });
});

describe("edge labels and kinds", () => {
  it("keeps labels readable when zoomed out, capped, never smaller than world size", () => {
    expect(edgeLabelScale(1)).toBe(1);
    expect(edgeLabelScale(1.6)).toBe(1);
    expect(edgeLabelScale(0.45)).toBeCloseTo(2);
    expect(edgeLabelScale(0.1)).toBe(2.4);
    expect(edgeLabelScale(0)).toBe(1);
  });

  it("draws deployment links quieter than runtime calls", () => {
    expect(isQuietEdgeKind("deploy")).toBe(true);
    for (const k of ["sync", "async", "data", "event", undefined]) expect(isQuietEdgeKind(k)).toBe(false);
  });
});

describe("card second line", () => {
  it("splits into whole parts so a narrow card drops a part instead of cutting a word", () => {
    expect(subtitleParts("TypeScript · Express 4")).toEqual(["TypeScript", "Express 4"]);
    expect(subtitleParts("Terraform · AWS · 12 resources")).toEqual(["Terraform", "AWS", "12 resources"]);
    expect(subtitleParts("Kubernetes")).toEqual(["Kubernetes"]);
    expect(subtitleParts("deploy/charts/api")).toEqual(["deploy/charts/api"]);
    expect(subtitleParts(" · ")).toEqual([]);
  });

  it("leaves room for the inside chip by its digits", () => {
    expect(chipPad(undefined)).toBe("pr-7");
    expect(chipPad(4)).toBe("pr-7");
    expect(chipPad(12)).toBe("pr-9");
  });
});
