// src/projects/settings-store.ts — the user's saved agent defaults in
// $RUAH_HOME/settings.json (~/.ruah): the agent the daemon starts with and the
// model / permission mode each agent starts with, plus the feature flags of
// CONTRACTS §13.6 (background agents, notifications) and the usage settings of
// §20.1 (`usage.readAppLogins`). Written atomically (temp +
// rename); unknown top-level keys are kept, so later settings can live in the
// same file. A missing or corrupt file reads as "nothing saved".
import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFileSync } from "./fs-util.js";
import type { AppFeatures, NotificationMode, UsageSettingsView } from "../contracts/ws.js";
import { resolveUsageSettings } from "../usage/settings.js";

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
export const DEFAULT_FEATURES: AppFeatures = {
  backgroundAgents: true,
  notifications: "background",
  usage: { readAppLogins: false, source: "default" },
};

/** A patch of the feature flags (settings.set). */
export interface FeaturesPatch {
  backgroundAgents?: boolean;
  notifications?: NotificationMode;
  usage?: { readAppLogins?: boolean };
}

/** The saved `usage.readAppLogins` (undefined when missing or not a boolean). */
function savedReadAppLogins(record: Record<string, unknown>): boolean | undefined {
  const usage = record.usage;
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const value = (usage as Record<string, unknown>).readAppLogins;
  return typeof value === "boolean" ? value : undefined;
}

/** Feature flags from the file's top-level keys; anything missing or invalid is the default. */
export function featuresOf(record: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): AppFeatures {
  const notifications = record.notifications;
  return {
    backgroundAgents: typeof record.backgroundAgents === "boolean" ? record.backgroundAgents : DEFAULT_FEATURES.backgroundAgents,
    notifications: NOTIFICATION_MODES.includes(notifications as NotificationMode) ? (notifications as NotificationMode) : DEFAULT_FEATURES.notifications,
    usage: resolveUsageSettings(env, savedReadAppLogins(record)),
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
  /** mtime of the file the cache came from (or we wrote): another process's write reloads it. */
  private cacheMtime: number | null = null;
  private readonly featureListeners = new Set<(before: AppFeatures, after: AppFeatures) => void>();

  constructor(
    home: string,
    private readonly options: {
      onError?: (line: string) => void;
      /** RUAH_USAGE_READ_LOGINS is read from here (tests); default process.env. */
      env?: NodeJS.ProcessEnv;
    } = {},
  ) {
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
      this.cacheMtime = this.mtime();
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
    return featuresOf(this.load().extra, this.options.env);
  }

  /** §20.1: whether an agent app's saved login may be read (env > saved > off). */
  usageSettings(): UsageSettingsView {
    return this.features().usage;
  }

  /** Called after updateFeatures changed something (e.g. to drop readings made under the old setting). */
  onFeaturesChange(listener: (before: AppFeatures, after: AppFeatures) => void): () => void {
    this.featureListeners.add(listener);
    return () => this.featureListeners.delete(listener);
  }

  updateFeatures(patch: FeaturesPatch): AppFeatures {
    const before = this.features();
    const after = this.writeFeatures(patch);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      for (const listener of [...this.featureListeners]) {
        try {
          listener(before, after);
        } catch (err) {
          this.options.onError?.(`ruah: a settings listener failed: ${(err as Error).message}`);
        }
      }
    }
    return after;
  }

  private writeFeatures(patch: FeaturesPatch): AppFeatures {
    const { settings, extra } = this.load();
    const nextExtra = { ...extra };
    if (patch.backgroundAgents !== undefined) nextExtra.backgroundAgents = patch.backgroundAgents;
    if (patch.notifications !== undefined && NOTIFICATION_MODES.includes(patch.notifications)) nextExtra.notifications = patch.notifications;
    if (patch.usage?.readAppLogins !== undefined) {
      const usage = extra.usage !== null && typeof extra.usage === "object" && !Array.isArray(extra.usage) ? (extra.usage as Record<string, unknown>) : {};
      nextExtra.usage = { ...usage, readAppLogins: patch.usage.readAppLogins };
    }
    if (JSON.stringify(nextExtra) === JSON.stringify(extra)) return this.features();
    this.cache = { settings, extra: nextExtra };
    try {
      atomicWriteFileSync(this.file, `${JSON.stringify({ ...nextExtra, version: 1, ...settings }, null, 2)}\n`);
      this.cacheMtime = this.mtime();
    } catch (err) {
      this.options.onError?.(`ruah: writing ${this.file} failed: ${(err as Error).message}`);
    }
    return this.features();
  }

  private mtime(): number | null {
    try {
      return fs.statSync(this.file).mtimeMs;
    } catch {
      return null;
    }
  }

  private load(): { settings: SavedAgentSettings; extra: Record<string, unknown> } {
    // Reused until another process (`ruah app usage settings`, a hand edit) changes the file.
    if (this.cache !== undefined && this.mtime() === this.cacheMtime) return this.cache;
    this.cacheMtime = this.mtime();
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
