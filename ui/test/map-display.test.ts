import { describe, expect, it } from "vitest";
import { cardText, cardTool, chipPad, edgeLabelScale, isQuietEdgeKind, subtitleParts } from "@/components/editor/canvas/display";
import { FIT_ALL, asFramed, fitCamera, panBy, restoredCamera, zoomAround } from "@/components/editor/canvas/geometry";

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

describe("a framed map stays framed; a map the user moved stays put", () => {
  // The canvas marks the cameras it frames itself (Fit to view, a level opened fresh); a pan or a
  // zoom drops the mark. Regression: the camera used to be judged "a fit" from its geometry, so a
  // pan along the axis that doesn't limit the zoom (or any pan of a map capped at 100 %) was
  // thrown away on reload, on returning to the level and on every resize.
  const wide = { x: 40, y: -20, w: 1540, h: 640 }; // width limits the fit in a 948×812 canvas
  const small = { x: 0, y: 0, w: 400, h: 200 }; // fits at the 100 % cap with room around it

  it("a frame is re-framed when the level is restored, at whatever size the canvas has then", () => {
    const frame = asFramed(fitCamera(wide, 948, 812, FIT_ALL));
    expect(frame.framed).toBe(true);
    expect(restoredCamera(frame, false)).toBe("fit");
    expect(restoredCamera(JSON.parse(JSON.stringify(frame)), false)).toBe("fit"); // after a save
    expect(restoredCamera(undefined, false)).toBe("fit");
    expect(restoredCamera(null, false)).toBe("fit");
  });

  it("keeps a pan along the axis that does not limit the zoom", () => {
    const frame = asFramed(fitCamera(wide, 948, 812, FIT_ALL));
    for (const [dx, dy] of [
      [0, 60],
      [0, -150],
      [30, 0],
    ] as const) {
      const moved = panBy(frame, dx, dy);
      expect(moved.framed, `${dx},${dy}`).toBeUndefined();
      expect(restoredCamera(moved, false), `${dx},${dy}`).toEqual({ k: frame.k, x: frame.x + dx, y: frame.y + dy });
    }
  });

  it("keeps a pan of a map whose fit is capped at 100 %", () => {
    const frame = asFramed(fitCamera(small, 948, 812, FIT_ALL));
    expect(frame.k).toBe(1);
    const moved = panBy(frame, -200, 0);
    expect(restoredCamera(moved, false)).toEqual({ k: 1, x: frame.x - 200, y: frame.y });
  });

  it("keeps a zoom, even one centred on the map", () => {
    const frame = asFramed(fitCamera(wide, 948, 812, FIT_ALL));
    const zoomed = zoomAround(frame, 474, 406, 1.25);
    expect(zoomed.framed).toBeUndefined();
    expect(zoomed.k).toBeCloseTo(frame.k * 1.25);
    expect(restoredCamera(zoomed, false)).toBe(zoomed);
    // Zooming around a screen point keeps that point still.
    const wx = (474 - frame.x) / frame.k;
    expect(474 - wx * zoomed.k).toBeCloseTo(zoomed.x);
  });

  it("a level drilled into opens framed, whatever was saved", () => {
    expect(restoredCamera(panBy(fitCamera(wide, 948, 812, FIT_ALL), 10, 10), true)).toBe("fit");
  });
});

describe("zoomed-out cards", () => {
  it("name the tool of a shortened IaC name on the second line", () => {
    expect(cardTool(cardText({ label: "Kubernetes: prod", subtitle: "Kubernetes" }))).toBe("Kubernetes");
    expect(cardTool(cardText({ label: "Helm: api", subtitle: "deploy/charts/api", tech: ["Helm"] }))).toBe("Helm");
    expect(cardTool(cardText({ label: "CI/CD: GitHub Actions", subtitle: "CI/CD" }))).toBe("CI/CD");
    expect(cardTool(cardText({ label: "api", subtitle: "TypeScript" }))).toBe("");
  });
});
