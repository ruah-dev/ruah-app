import { z } from "zod";

// CONTRACTS.md §7 — the integrated terminal. One WebSocket per viewer at
// /ws/terminal?token=… (token from GET /api/terminal/token) multiplexes every
// terminal of the daemon; messages are JSON text frames. Terminal output is
// UTF-8 text decoded by the PTY layer (split multi-byte sequences are held
// back until complete), so JSON strings carry it losslessly.

export const TERMINAL_MAX_INPUT = 65_536;
export const TERMINAL_MAX_TITLE = 80;

const Dim = z.number().int().min(2).max(1000);
const TerminalId = z.string().min(1).max(64);

export const TerminalInfoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  cwd: z.string(), // absolute, where the shell started
  shell: z.string(),
  pid: z.number().int().nullable(),
  cols: z.number().int(),
  rows: z.number().int(),
  createdAt: z.string(), // ISO
  status: z.enum(["running", "exited"]),
  exitCode: z.number().int().nullable(),
  signal: z.number().int().nullable(),
});
export type TerminalInfo = z.infer<typeof TerminalInfoSchema>;

export const TerminalClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create"),
    requestId: z.string().min(1).max(64),
    /** Repo-relative (system: "<repoId>/<rel>") or absolute path inside the project; a file → its folder. */
    cwd: z.string().max(4096).optional(),
    /** Element whose folder becomes the cwd (its `path`, else its first file's folder). */
    nodeId: z.string().max(512).optional(),
    cols: Dim,
    rows: Dim,
    title: z.string().max(TERMINAL_MAX_TITLE).optional(),
    /** Typed at the first prompt without Enter ("Run in terminal"); never executed by the daemon. */
    input: z.string().max(TERMINAL_MAX_INPUT).optional(),
  }),
  z.object({ type: z.literal("list"), requestId: z.string().max(64).optional(), projectId: z.string().max(64).optional() }),
  z.object({ type: z.literal("attach"), id: TerminalId }),
  z.object({ type: z.literal("detach"), id: TerminalId }),
  z.object({ type: z.literal("input"), id: TerminalId, data: z.string().max(TERMINAL_MAX_INPUT) }),
  z.object({ type: z.literal("resize"), id: TerminalId, cols: Dim, rows: Dim }),
  z.object({ type: z.literal("kill"), id: TerminalId }),
  z.object({ type: z.literal("rename"), id: TerminalId, title: z.string().max(TERMINAL_MAX_TITLE) }),
  /** Clears the replay buffer (⌘K in the viewer clears the screen too). */
  z.object({ type: z.literal("clear"), id: TerminalId }),
  /** Flow control: characters of output this client has rendered since its last ack. */
  z.object({ type: z.literal("ack"), id: TerminalId, chars: z.number().int().min(0).max(100_000_000) }),
]);
export type TerminalClientMessage = z.infer<typeof TerminalClientMessageSchema>;

export type TerminalServerMessage =
  | { type: "ready"; available: true; projectId: string | null; shell: string }
  | { type: "ready"; available: false; reason: string; projectId: string | null }
  | { type: "created"; requestId: string; terminal: TerminalInfo }
  | { type: "terminals"; projectId: string | null; terminals: TerminalInfo[]; requestId?: string }
  | { type: "attached"; id: string; terminal: TerminalInfo; replay: string }
  | { type: "output"; id: string; data: string }
  | { type: "exit"; id: string; exitCode: number | null; signal: number | null }
  | { type: "error"; requestId?: string; id?: string; message: string };
