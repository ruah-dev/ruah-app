import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LayerBreadcrumb } from "./LayerBreadcrumb.js";

describe("LayerBreadcrumb", () => {
  it("renders root as System and node names from the map", () => {
    const html = renderToStaticMarkup(
      <LayerBreadcrumb
        stack={[null, "api"]}
        names={{ api: "invoices-api" }}
        onJump={() => {}}
        onUp={() => {}}
      />,
    );
    expect(html).toContain("System");
    expect(html).toContain("invoices-api");
  });

  it("falls back to the raw id when no name is known", () => {
    const html = renderToStaticMarkup(
      <LayerBreadcrumb stack={[null, "ghost"]} names={{}} onJump={() => {}} onUp={() => {}} />,
    );
    expect(html).toContain("ghost");
  });

  it("disables Up at the root", () => {
    const html = renderToStaticMarkup(
      <LayerBreadcrumb stack={[null]} names={{}} onJump={() => {}} onUp={() => {}} />,
    );
    expect(html).toContain("disabled");
  });
});
