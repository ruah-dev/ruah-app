// src/engines/watch.ts — render one stored chat turn to static HTML via ruah-watch.
import * as fs from "node:fs";
import * as path from "node:path";
import { isChatId } from "../projects/chat-store.js";
import { projectIdFor } from "../projects/fs-util.js";
import { resolveEngineInvocation, runEngineJson, type EngineCliDeps } from "./cli.js";

const TURN_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,80}$/;
const HTML_NAME = /^turn-[A-Za-z0-9._-]+\.html$/;

export interface WatchReplay {
  path: string;
  name: string;
  turns: number;
}

function safeTurn(turnId: string): string {
  return turnId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function turnLine(raw: string, turnId: string): string | undefined {
  for (const line of raw.split(/\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const doc = JSON.parse(trimmed) as { turnId?: unknown };
      if (doc.turnId === turnId) return trimmed;
    } catch {
      // skip torn lines
    }
  }
  return undefined;
}

export async function renderChatTurn(options: {
  root: string;
  home: string;
  chatId: string;
  turnId: string;
  deps?: EngineCliDeps;
}): Promise<{ ok: true; data: WatchReplay } | { ok: false; status: number; error: string }> {
  if (!isChatId(options.chatId)) return { ok: false, status: 400, error: "invalid chat id" };
  if (!TURN_ID.test(options.turnId)) return { ok: false, status: 400, error: "invalid turn id" };
  const deps = options.deps ?? {};
  if (resolveEngineInvocation("watch", deps) === null) {
    return {
      ok: false,
      status: 424,
      error: "ruah watch is not installed. npm i -g @ruah-dev/cli @ruah-dev/watch",
    };
  }
  const projectId = projectIdFor(options.root);
  const chatFile = path.join(options.home, "projects", projectId, "chats", `${options.chatId}.jsonl`);
  if (!fs.existsSync(chatFile)) return { ok: false, status: 404, error: "chat not found" };
  const line = turnLine(fs.readFileSync(chatFile, "utf8"), options.turnId);
  if (line === undefined) return { ok: false, status: 404, error: "turn not found" };

  const replayDir = path.join(options.home, "replays");
  fs.mkdirSync(replayDir, { recursive: true });
  const stem = `turn-${safeTurn(options.turnId)}`;
  const slicePath = path.join(replayDir, `${stem}.jsonl`);
  const htmlPath = path.join(replayDir, `${stem}.html`);
  fs.writeFileSync(slicePath, `${line}\n`, "utf8");

  const result = await runEngineJson<{ ok?: boolean; written?: string; turns?: number; error?: string }>(
    "watch",
    ["render", slicePath, "--out", htmlPath, "--no-redact"],
    {
      cwd: options.root,
      deps,
    },
  );
  if (!result.ok) return { ok: false, status: result.status, error: result.error };
  if (result.data.ok === false) {
    return { ok: false, status: 502, error: result.data.error ?? "ruah watch render failed" };
  }
  const written = typeof result.data.written === "string" ? result.data.written : htmlPath;
  return {
    ok: true,
    data: { path: written, name: path.basename(written), turns: result.data.turns ?? 0 },
  };
}

/** HTML previously written under $RUAH_HOME/replays. Refuses any other path. */
export function readReplayHtml(home: string, name: string): string | undefined {
  if (!HTML_NAME.test(name)) return undefined;
  const dir = path.resolve(home, "replays");
  const full = path.resolve(dir, name);
  if (full !== path.join(dir, name)) return undefined;
  if (!fs.existsSync(full)) return undefined;
  return fs.readFileSync(full, "utf8");
}
