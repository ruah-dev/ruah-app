// src/engines/index.ts — EnginesService facade for HTTP + session hooks.
import type { Architecture, ArchNode } from "../contracts/architecture.js";
import type { EngineCliDeps } from "./cli.js";
import { detectSpecsForNode, runConv } from "./conv.js";
import { runEvalOnNode } from "./eval.js";
import {
  loadVerifyState,
  runVerifyForNode,
  syncVerifyJson,
  type NodeVerifyState,
} from "./verify.js";

export type { NodeVerifyState, VerifyBadge } from "./verify.js";
export { badgeFromReport } from "./verify.js";

export interface EnginesDeps {
  cli?: EngineCliDeps;
  /** Resolve current project root; null = launcher. */
  root: () => string | null;
  /** Current architecture; null when none. */
  architecture: () => Architecture | null;
  debug?: (line: string) => void;
}

export class EnginesService {
  private readonly nodeState = new Map<string, NodeVerifyState>();

  constructor(private readonly deps: EnginesDeps) {}

  private requireRoot(): string {
    const root = this.deps.root();
    if (!root) throw Object.assign(new Error("no project open"), { status: 409 });
    return root;
  }

  verifyState(): Record<string, NodeVerifyState> {
    const root = this.deps.root();
    if (!root) return {};
    const disk = loadVerifyState(root);
    return { ...disk, ...Object.fromEntries(this.nodeState) };
  }

  syncVerify(workflows?: Parameters<typeof syncVerifyJson>[0]["workflows"]): {
    path: string;
    criteriaCount: number;
  } {
    const root = this.requireRoot();
    const arch = this.deps.architecture();
    if (!arch) throw Object.assign(new Error("no architecture loaded"), { status: 409 });
    return syncVerifyJson({ root, architecture: arch, ...(workflows !== undefined ? { workflows } : {}) });
  }

  async runVerify(nodeId: string): Promise<NodeVerifyState> {
    const root = this.requireRoot();
    const state = await runVerifyForNode({ root, nodeId, ...(this.deps.cli !== undefined ? { deps: this.deps.cli } : {}) });
    this.nodeState.set(nodeId, state);
    return state;
  }

  /** Fire-and-forget after an agent turn; never throws into the session hub. */
  afterTurn(nodeId: string | undefined): void {
    if (!nodeId) return;
    const root = this.deps.root();
    if (!root) return;
    void this.runVerify(nodeId).catch((err) => {
      this.deps.debug?.(
        `verify after turn failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  async runEval(nodeId: string, prompt: string) {
    const root = this.requireRoot();
    return runEvalOnNode({ root, nodeId, prompt, ...(this.deps.cli !== undefined ? { deps: this.deps.cli } : {}) });
  }

  detectConv(nodeId: string) {
    const root = this.requireRoot();
    const arch = this.deps.architecture();
    const node = arch?.nodes.find((n) => n.id === nodeId) as ArchNode | undefined;
    if (!node) throw Object.assign(new Error(`unknown node: ${nodeId}`), { status: 404 });
    return detectSpecsForNode(root, node);
  }

  async runConv(nodeId: string, specPath: string, command: "inspect" | "curate" | "generate" | "validate") {
    const root = this.requireRoot();
    // Ensure the node exists (and optionally that the spec was detected).
    this.detectConv(nodeId);
    return runConv({ root, specPath, command, ...(this.deps.cli !== undefined ? { deps: this.deps.cli } : {}) });
  }
}
