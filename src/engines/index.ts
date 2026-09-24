// src/engines/index.ts — EnginesService facade for HTTP + session hooks.
import type { Architecture, ArchNode } from "../contracts/architecture.js";
import { detectSpecsForNode, runConv } from "./conv.js";
import { runEvalOnNode } from "./eval.js";
import { runGuardAudit, runGuardScan } from "./guard.js";
import { runOptUsage } from "./opt.js";
import { engineStatus, type EngineCliDeps } from "./cli.js";
import { readReplayHtml, renderChatTurn } from "./watch.js";
import { ruahHome } from "../usage/log.js";
import * as path from "node:path";
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
  /** $RUAH_HOME. Defaults to ruahHome() so tests that set RUAH_HOME stay isolated. */
  home?: () => string;
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

  private cliDeps(): EngineCliDeps | undefined {
    return this.deps.cli;
  }

  private homeDir(): string {
    return this.deps.home?.() ?? ruahHome();
  }

  status() {
    return engineStatus(this.cliDeps() ?? {});
  }

  async guardScan() {
    const root = this.requireRoot();
    return runGuardScan({ root, ...(this.deps.cli !== undefined ? { deps: this.deps.cli } : {}) });
  }

  async guardAudit(last?: number) {
    const root = this.requireRoot();
    return runGuardAudit({
      root,
      ...(last !== undefined ? { last } : {}),
      ...(this.deps.cli !== undefined ? { deps: this.deps.cli } : {}),
    });
  }

  async optUsage() {
    const file = path.join(this.homeDir(), "usage.jsonl");
    return runOptUsage({
      file,
      ...(this.deps.cli !== undefined ? { deps: this.deps.cli } : {}),
    });
  }

  async watchReplay(chatId: string, turnId: string) {
    const root = this.requireRoot();
    return renderChatTurn({
      root,
      home: this.homeDir(),
      chatId,
      turnId,
      ...(this.deps.cli !== undefined ? { deps: this.deps.cli } : {}),
    });
  }

  watchHtml(name: string): string | undefined {
    return readReplayHtml(this.homeDir(), name);
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
