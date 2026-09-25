// The Phantom family (components/brand): tones follow the palette tokens, every pose / scene /
// agent ghost renders as decorative SVG (or an image with a label), agent ids map to tints, and
// the empty state wires tone + live region.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  EmptyState,
  POSES,
  POSE_NAMES,
  Phantom,
  PhantomAgent,
  PhantomPose,
  PhantomScene,
  SCENE_NAMES,
  agentTintOf,
  canonicalTone,
  toneVar,
} from "@/components/brand";
import { AGENT_TINT_IDS, resolveTokens } from "@/design/tokens";

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("tones", () => {
  it("maps legacy names onto the palette's roles", () => {
    expect(canonicalTone("teal")).toBe("brand");
    expect(canonicalTone("lavender")).toBe("ai");
    expect(canonicalTone("sage")).toBe("ok");
    expect(canonicalTone("coral")).toBe("bad");
    expect(canonicalTone("muted")).toBe("muted");
    expect(canonicalTone("claude")).toBe("claude");
  });

  it("every tone's variable is a generated token", () => {
    const tokens = resolveTokens("teal", "dark");
    for (const tone of ["brand", "ai", "ok", "warn", "bad", "info", "soft", "muted", "cream", "extra-1", "extra-2", "extra-3", ...AGENT_TINT_IDS] as const) {
      const name = toneVar(tone).slice(2);
      expect(tokens[name], tone).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("an expression's ghost carries its canonical tone", () => {
    expect(html(createElement(Phantom, { expression: "agent" }))).toContain('data-tone="ai"');
    expect(html(createElement(Phantom, { expression: "loading" }))).toContain('data-tone="soft"');
    expect(html(createElement(Phantom, { expression: "idle", tone: "sage" }))).toContain('data-tone="ok"');
  });
});

describe("poses", () => {
  it("has the roles the app needs (at least 12 new poses)", () => {
    for (const p of [
      "sleeping",
      "celebrating",
      "reading",
      "building",
      "searching",
      "cloud",
      "infra",
      "terminal",
      "detective",
      "traveler",
      "keyholder",
      "headset",
    ] as const) {
      expect(POSE_NAMES).toContain(p);
    }
    expect(POSE_NAMES.length).toBeGreaterThanOrEqual(12);
  });

  it("each pose renders an SVG in the 600-unit box with the body silhouette", () => {
    for (const pose of POSE_NAMES) {
      const out = html(createElement(PhantomPose, { pose, size: 96 }));
      expect(out, pose).toContain('viewBox="0 0 600 600"');
      expect(out, pose).toContain("phantom-skin");
      expect(out, pose).toContain(`data-tone="${POSES[pose].tone}"`);
      expect(out, pose).toContain('aria-hidden="true"');
      // Colours are tokens, never literals.
      expect(out, pose).not.toMatch(/fill="#|stroke="#/);
    }
  });

  it("a labelled pose is an image", () => {
    const out = html(createElement(PhantomPose, { pose: "detective", label: "Debugging" }));
    expect(out).toContain('role="img"');
    expect(out).toContain('aria-label="Debugging"');
  });

  it("still ghosts opt out of motion", () => {
    expect(html(createElement(PhantomPose, { pose: "sleeping", still: true }))).toContain("data-still");
  });
});

describe("agents and scenes", () => {
  it("maps daemon agent ids onto tints", () => {
    expect(agentTintOf("claude")).toBe("claude");
    expect(agentTintOf("claude-acp")).toBe("claude");
    expect(agentTintOf("cursor")).toBe("cursor");
    expect(agentTintOf("open-code")).toBe("opencode");
    expect(agentTintOf("kiro-cli")).toBe("kiro");
    expect(agentTintOf("aider")).toBeUndefined();
    expect(agentTintOf(undefined)).toBeUndefined();
  });

  it("an agent's ghost wears its tint, and its emblem from 32 px", () => {
    const big = html(createElement(PhantomAgent, { agent: "grok", size: 72 }));
    expect(big).toContain('data-tone="grok"');
    const small = html(createElement(PhantomAgent, { agent: "grok", size: 16 }));
    expect(small.length).toBeLessThan(big.length);
    expect(html(createElement(PhantomAgent, { agent: "aider" }))).toContain('data-tone="ai"');
  });

  it("scenes render several figures with their own tones", () => {
    for (const scene of SCENE_NAMES) {
      const out = html(createElement(PhantomScene, { scene, height: 100 }));
      expect(out, scene).toContain("phantom-figure");
      expect((out.match(/phantom-figure/g) ?? []).length, scene).toBeGreaterThanOrEqual(2);
    }
    const crew = html(createElement(PhantomScene, { scene: "crew" }));
    for (const a of AGENT_TINT_IDS) expect(crew).toContain(`data-tone="${a}"`);
  });
});

describe("EmptyState", () => {
  it("renders title, body, eyebrow in the tone colour and a live region", () => {
    const out = html(
      createElement(EmptyState, {
        pose: "detective",
        eyebrow: "Failed",
        title: "Couldn't load",
        body: "The daemon did not answer.",
        live: "assertive",
      }),
    );
    expect(out).toContain("Couldn&#x27;t load");
    expect(out).toContain("text-bad");
    expect(out).toContain('role="alert"');
    expect(out).toContain("var(--ph-bad)");
  });
});
