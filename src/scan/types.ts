// Internal types shared by the scanner detectors (not part of CONTRACTS.md).
import type { FileList } from "./walk.js";

export type Language = "js" | "python" | "go" | "rust" | "java" | "unknown";

export interface DepRef {
  name: string;
  dev: boolean;
  version?: string;
}

export interface PackageInfo {
  dir: string; // repo-relative; "" = repo root
  manifest: string | null; // repo-relative manifest path
  name: string; // declared package name, else directory basename
  description?: string;
  language: Language;
  deps: DepRef[]; // declared dependencies, sorted by name
  entryHints: string[]; // repo-relative files the manifest names (main, bin, module)
  scripts: Record<string, string>;
  goModule?: string; // go.mod `module` path
}

export interface ScanContext {
  root: string;
  fl: FileList;
}
