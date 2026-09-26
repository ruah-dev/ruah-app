// src/projects/settings-store.ts — the user's saved agent defaults in
// $RUAH_HOME/settings.json (~/.ruah): the agent the daemon starts with and the
// model / permission mode each agent starts with, plus the feature flags of
// CONTRACTS §13.6 (background agents, notifications). Written atomically (temp +
// rename); unknown top-level keys are kept, so later settings can live in the
// same file. A missing or corrupt file reads as "nothing saved".
import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFileSync } from "./fs-util.js";
import type { AppFeatures, NotificationMode } from "../contracts/ws.js";

export interface SavedAgentSettings {
  /** Agent the daemon starts with when `serve` gets no --agent. */
  defaultAgentId?: string;
  /** Model id per agent id. */
  models: Record<string, string>;
  /** Permission mode id per agent id. */
  modes: Record<string, string>;
}

/** null removes the entry. */
export interface AgentSettingsPatch {
  defaultAgentId?: string;
  models?: Record<string, string | null>;
  modes?: Record<string, string | null>;
}

const MAX_ID_LENGTH = 200;
const NOTIFICATION_MODES: readonly NotificationMode[] = ["background", "always", "off"];
export const DEFAULT_FEATURES: AppFeatures = { backgroundAgents: true, notifications: "background" };

/** Feature flags from the file's top-level keys; anything missing or invalid is the default. */
export function featuresOf(record: Record<string, unknown>): AppFeatures {
  const notifications = record.notifications;
  return {
    backgroundAgents: typeof record.backgroundAgents === "boolean" ? record.backgroundAgents : DEFAULT_FEATURES.backgroundAgents,
    notifications: NOTIFICATION_MODES.includes(notifications as NotificationMode) ? (notifications as NotificationMode) : DEFAULT_FEATURES.notifications,
  };
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string" && entry.length > 0 && entry.length <= MAX_ID_LENGTH) out[key] = entry;
  }
  return out;
}

function applyPatch(target: Record<string, string>, patch: Record<string, string | null> | undefined): Record<string, string> {
  if (patch === undefined) return target;
  const next = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value.trim().length === 0) delete next[key];
    else next[key] = value.trim().slice(0, MAX_ID_LENGTH);
  }
  return next;
}

export class SettingsStore {
  readonly file: string;
  private cache: { settings: SavedAgentSettings; extra: Record<string, unknown> } | undefined;

  constructor(home: string, private readonly options: { onError?: (line: string) => void } = {}) {
    this.file = path.join(home, "settings.json");
  }

  get(): SavedAgentSettings {
    const { settings } = this.load();
    return { ...settings, models: { ...settings.models }, modes: { ...settings.modes } };
  }

  update(patch: AgentSettingsPatch): SavedAgentSettings {
    const { settings, extra } = this.load();
    const next: SavedAgentSettings = {
      ...(settings.defaultAgentId !== undefined ? { defaultAgentId: settings.defaultAgentId } : {}),
      ...(patch.defaultAgentId !== undefined && patch.defaultAgentId.length > 0 ? { defaultAgentId: patch.defaultAgentId } : {}),
      models: applyPatch(settings.models, patch.models),
      modes: applyPatch(settings.modes, patch.modes),
    };
    const unchanged = JSON.stringify(next) === JSON.stringify(settings);
    this.cache = { settings: next, extra };
    if (unchanged) return this.get();
    try {
      atomicWriteFileSync(this.file, `${JSON.stringify({ ...extra, version: 1, ...next }, null, 2)}\n`);
    } catch (err) {
      this.options.onError?.(`ruah: writing ${this.file} failed: ${(err as Error).message}`);
    }
    return this.get();
  }

  /**
   * §13.6 feature flags (top-level keys of the same file): `backgroundAgents`
   * (default true: a turn keeps running when you switch projects) and
   * `notifications` ("background" default | "always" | "off").
   */
  features(): AppFeatures {
    return featuresOf(this.load().extra);
  }

  updateFeatures(patch: Partial<AppFeatures>): AppFeatures {
    const { settings, extra } = this.load();
    const nextExtra = { ...extra };
    if (patch.backgroundAgents !== undefined) nextExtra.backgroundAgents = patch.backgroundAgents;
    if (patch.notifications !== undefined && NOTIFICATION_MODES.includes(patch.notifications)) nextExtra.notifications = patch.notifications;
    if (JSON.stringify(nextExtra) === JSON.stringify(extra)) return this.features();
    this.cache = { settings, extra: nextExtra };
    try {
      atomicWriteFileSync(this.file, `${JSON.stringify({ ...nextExtra, version: 1, ...settings }, null, 2)}\n`);
    } catch (err) {
      this.options.onError?.(`ruah: writing ${this.file} failed: ${(err as Error).message}`);
    }
    return this.features();
  }

  /** §20: the folder the new project wizard proposes (the parent of the last project created in the app). */
  newProjectParent(): string | undefined {
    const value = this.load().extra.newProject;
    const dir = value !== null && typeof value === "object" ? (value as { parentDir?: unknown }).parentDir : undefined;
    return typeof dir === "string" && dir.length > 0 && dir.length <= 4096 ? dir : undefined;
  }

  setNewProjectParent(dir: string): void {
    if (this.newProjectParent() === dir) return;
    const { settings, extra } = this.load();
    const previous = extra.newProject !== null && typeof extra.newProject === "object" ? (extra.newProject as Record<string, unknown>) : {};
    const nextExtra = { ...extra, newProject: { ...previous, parentDir: dir } };
    this.cache = { settings, extra: nextExtra };
    try {
      atomicWriteFileSync(this.file, `${JSON.stringify({ ...nextExtra, version: 1, ...settings }, null, 2)}\n`);
    } catch (err) {
      this.options.onError?.(`ruah: writing ${this.file} failed: ${(err as Error).message}`);
    }
  }

  private load(): { settings: SavedAgentSettings; extra: Record<string, unknown> } {
    if (this.cache !== undefined) return this.cache;
    let raw: unknown = {};
    try {
      raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.options.onError?.(`ruah: ${this.file} is unreadable (${(err as Error).message}); using no saved defaults`);
      }
    }
    const record = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const { defaultAgentId, models, modes, version: _version, ...extra } = record;
    const settings: SavedAgentSettings = {
      ...(typeof defaultAgentId === "string" && defaultAgentId.length > 0 ? { defaultAgentId } : {}),
      models: stringRecord(models),
      modes: stringRecord(modes),
    };
    this.cache = { settings, extra };
    return this.cache;
  }
}
