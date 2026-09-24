// A one-shot, read-only Claude agent for `ruah app system suggest --agent
// claude` (no daemon needed): Claude Agent SDK query() with cwd = the system
// folder and every repo as an additional directory, the user's own Claude
// Code settings and login, and only read tools (Read, Grep, Glob, LS) —
// anything else is denied by canUseTool. Returns the final answer text.
import type { RunAgent } from "./suggest.js";

export interface ClaudeRunAgentOptions {
  cwd: string;
  additionalDirectories: string[];
  model?: string;
  /** Upper bound on agent turns (tool round trips), default 40. */
  maxTurns?: number;
  onProgress?: (line: string) => void;
}

const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS"]);

export function claudeRunAgent(opts: ClaudeRunAgentOptions): RunAgent {
  return async (prompt) => {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const { resolveClaudeSdkExecutablePath } = await import("../acp/claude-executable.js");
    const executable = process.env.CLAUDE_CODE_EXECUTABLE;
    const q = sdk.query({
      prompt,
      options: {
        cwd: opts.cwd,
        additionalDirectories: opts.additionalDirectories,
        settingSources: ["user", "project", "local"],
        allowedTools: [...READ_TOOLS],
        disallowedTools: ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "WebFetch", "WebSearch", "Task"],
        permissionMode: "default",
        maxTurns: opts.maxTurns ?? 40,
        canUseTool: async (toolName, input) =>
          READ_TOOLS.has(toolName)
            ? { behavior: "allow", updatedInput: input }
            : { behavior: "deny", message: "Suggest connections is read-only: use Read, Grep and Glob only." },
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(executable !== undefined && executable.length > 0
          ? { pathToClaudeCodeExecutable: resolveClaudeSdkExecutablePath(executable, process.env) }
          : {}),
      },
    });
    let answer = "";
    let lastText = "";
    for await (const message of q) {
      if (message.type === "assistant") {
        const content = (message.message as { content?: unknown }).content;
        if (Array.isArray(content)) {
          for (const block of content as { type?: string; text?: string; name?: string }[]) {
            if (block.type === "text" && typeof block.text === "string") lastText = block.text;
            if (block.type === "tool_use" && typeof block.name === "string") opts.onProgress?.(`agent: ${block.name}`);
          }
        }
      } else if (message.type === "result") {
        if (message.subtype === "success") answer = message.result;
        else throw new Error(`the agent stopped: ${message.subtype}`);
      }
    }
    return answer !== "" ? answer : lastText;
  };
}
