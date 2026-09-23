// `ruah app scan --describe` (PLAN.md 2.4, ASSUMPTIONS.md 23) — stub.
//
// The real implementation sends one prompt listing every node (id, path,
// files) through the AcpBridge under a read-only auto-permission policy
// (allow read/search/think, reject the rest), with a 3-minute timeout, and
// writes back `{ "<id>": "<2 sentences>" }` only for ids that exist. Until the
// lead wires the bridge in, this returns the architecture unchanged and says
// why, so the flag is accepted and the heuristic descriptions stay.
import type { Architecture } from "../contracts/architecture.js";

export interface DescribeResult {
  architecture: Architecture;
  described: number; // nodes whose description was filled by the agent
  message: string;
}

export const DESCRIBE_TIMEOUT_MS = 3 * 60 * 1000;

export async function describeArchitecture(architecture: Architecture, _root: string): Promise<DescribeResult> {
  return {
    architecture,
    described: 0,
    message: "--describe needs the agent bridge, which is not wired into scan yet; kept heuristic descriptions",
  };
}

// Applies an agent answer `{ "<id>": "<description>" }` to the architecture,
// ignoring unknown ids and non-string values. Exposed for the future bridge
// wiring and for tests.
export function applyDescriptions(architecture: Architecture, answer: unknown): { architecture: Architecture; described: number } {
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) return { architecture, described: 0 };
  const map = answer as Record<string, unknown>;
  let described = 0;
  const nodes = architecture.nodes.map((n) => {
    const d = map[n.id];
    if (typeof d !== "string" || d.trim() === "") return n;
    described++;
    return { ...n, description: d.trim().slice(0, 400) };
  });
  return { architecture: { ...architecture, nodes }, described };
}
