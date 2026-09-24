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
export {
  addRepos,
  deriveRepoId,
  initSystem,
  readArchitectureFile,
  readScanState,
  rebuildSystem,
  removeRepo,
  renameInArchitecture,
  renameRepo,
  repoRemapper,
  rescanRepo,
  SCAN_STATE_FILE,
  SYSTEM_ARCHITECTURE_FILE,
  SystemManageError,
  type InitResult,
  type RebuildOptions,
  type RenameReport,
  type RepoInput,
  type ScanState,
} from "./manage.js";
export { parseGitStatus, repoGitStatus, systemStatus, type GitStatus, type RepoStatus, type SystemStatus } from "./status.js";
export { cloneGithubRepo, GITHUB_OWNER, GITHUB_REPO, listGithubRepos, type GithubRepo } from "./github.js";
export {
  acceptPending,
  emptySuggestions,
  findPending,
  livePending,
  readSuggestionsFile,
  recordSuggestionRun,
  rejectPending,
  suggestionId,
  SUGGESTIONS_FILE,
  unreject,
  writeSuggestionsFile,
  type RejectedSuggestionEntry,
  type StoredSuggestion,
  type SuggestionsFile,
} from "./suggestions-store.js";
export { crossRepoSignalEdges, runSuggestPass, type SuggestPassOptions, type SuggestPassResult } from "./suggest-run.js";
