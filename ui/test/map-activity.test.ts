// Live map edits by agents (CONTRACTS §1.7), viewer side: which elements flash after an agent
// op, the toast / chat-row wording, and "Keep" / editing adopting an agent-made element.
import { describe, expect, test } from "vitest";
import type { Architecture } from "../src/lib/contracts";
import { changeGlyph, changeText, noteArchitectureUpdate, onMapActivity, summarizeChanges, type MapActivityEvent } from "../src/lib/map-activity";
import { keepAgentElement, patchNode } from "../src/lib/architecture-edit";
import { toGraph, indexArchitecture } from "../src/lib/architecture";

const BEFORE: Architecture = {
  version: 1,
  name: "t",
  nodes: [
    { id: "api", type: "service", name: "api", x: 0, y: 0 },
    { id: "data", type: "datastore", name: "data", x: 260, y: 0 },
    { id: "old", type: "module", name: "old", x: 0, y: 110 },
  ],
  edges: [{ from: "api", to: "data" }],
  workflows: [],
};

const AFTER: Architecture = {
  ...BEFORE,
  nodes: [
    { id: "api", type: "service", name: "api", x: 0, y: 0 },
    { id: "data", type: "datastore", name: "data", x: 260, y: 0 },
    { id: "stripe", type: "external", name: "Stripe", x: 520, y: 0, origin: "agent" },
  ],
  edges: [{ from: "api", to: "data" }, { from: "data", to: "stripe", source: "agent" }],
};

describe("map activity", () => {
  test("agent ops emit an event; user saves do not", () => {
    const seen: MapActivityEvent[] = [];
    const off = onMapActivity((e) => seen.push(e));
    const changes = [{ action: "add", target: "element", id: "stripe", name: "Stripe", level: null }];
    noteArchitectureUpdate(BEFORE, AFTER, { kind: "user" }, changes);
    expect(seen).toHaveLength(0);
    noteArchitectureUpdate(BEFORE, AFTER, { kind: "agent", agentId: "claude", turnId: "t1" }, changes);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.by.turnId).toBe("t1");
    off();
  });

  test("wording", () => {
    expect(summarizeChanges([{ action: "add", target: "element", id: "p", name: "Payments service" }])).toBe("added Payments service");
    expect(
      summarizeChanges([
        { action: "add", target: "element", id: "p", name: "P" },
        { action: "connect", target: "link", id: "p->q", name: "P → Q" },
      ]),
    ).toBe("made 2 map changes");
    expect(changeGlyph({ action: "connect", target: "link", id: "a->b", name: "A → B" })).toBe("↔");
    expect(changeText({ action: "update", target: "element", id: "b", name: "Billing", fields: ["description"] })).toBe("Billing description");
    expect(changeText({ action: "connect", target: "link", id: "a->b", name: "A → B", label: "pay" })).toBe("A → B [pay]");
  });

  test("agent-made elements carry the marker until kept or edited", () => {
    const graph = toGraph(AFTER, null, indexArchitecture(AFTER));
    expect(graph.nodes.find((n) => n.id === "stripe")?.origin).toBe("agent");
    const kept = keepAgentElement(AFTER, "stripe");
    expect(kept?.nodes.find((n) => n.id === "stripe")?.origin).toBe("user");
    expect(kept?.edges.find((e) => e.to === "stripe")?.source).toBe("manual");
    expect(keepAgentElement(AFTER, "api")).toBeNull();
    const moved = patchNode(AFTER, "arch:root", "stripe", { x: 40, y: 40 });
    expect(moved?.nodes.find((n) => n.id === "stripe")?.origin).toBe("agent");
    const renamed = patchNode(AFTER, "arch:root", "stripe", { label: "Stripe API" });
    expect(renamed?.nodes.find((n) => n.id === "stripe")?.origin).toBe("user");
  });
});
