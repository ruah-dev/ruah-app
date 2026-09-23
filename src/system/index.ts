// Multi-repo systems (docs/MULTI-REPO.md): public surface for the daemon.
export {
  addRepo,
  loadSystem,
  parseSystemFile,
  relativeRepoPath,
  resolveSystemPath,
  REPO_ID_PATTERN,
  SYSTEM_FILE,
  SystemFileError,
  systemFilePath,
  toSystemFile,
  writeSystemFile,
  type LoadedRepo,
  type LoadedSystem,
  type ResolvedSystemPath,
  type SystemFile,
  type SystemRepo,
} from "./config.js";
export { buildSystemArchitecture, type BuildSystemOptions, type RepoReport, type SystemBuildResult } from "./build.js";
export { isHandAddedNode, mergeSystemWithExisting } from "./merge.js";
export { detectCrossRepoSignals, type CrossSignal, type Endpoint, type SignalRepo } from "./signals.js";
export {
  acceptSuggestion,
  extractJson,
  parseSuggestions,
  suggestConnections,
  type RejectedSuggestion,
  type RunAgent,
  type SuggestedEdge,
  type SuggestOptions,
  type SuggestResult,
  type SuggestSystem,
} from "./suggest.js";
export { buildSuggestPrompt, SUGGEST_PROMPT_VERSION, type SuggestPromptInput } from "./suggest-prompt.js";
