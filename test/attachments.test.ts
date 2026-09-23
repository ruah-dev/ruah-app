// test/attachments.test.ts — CONTRACTS §5.6 image attachments: the store
// (magic-byte sniffing, pixel size, dedupe by hash, names), the HTTP endpoints
// (type sniffing, 10 MB limit, id validation / traversal, Origin 403, 409
// without a project, served headers) and prompts with attachments (image
// blocks before the text, turn.started + TurnRecord carry them, agents without
// image support are rejected).
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { AcpBridge, BridgeEvent, TurnHandle } from "../src/acp/bridge.js";
import type { AgentChoiceState, AgentState, ServerMessage, StopReason } from "../src/contracts/ws.js";
import { ClientMessageSchema } from "../src/contracts/ws.js";
import type { ArchitectureStore } from "../src/serve/architecture-store.js";
import { attachSession, SessionHub, type AgentSwitcher } from "../src/serve/session.js";
import { startServer } from "../src/serve/server.js";
import { ChatStore } from "../src/projects/chat-store.js";
import { AttachmentStore, attachmentName, imageSize, sniffImage } from "../src/projects/attachment-store.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** PNG signature + IHDR (CRC not checked by the store). */
function png(width: number, height: number, extra = 0): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(extra, 7)]);
}

/** SOI + APP0 (JFIF) + SOF0 with the given size. */
function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.set([0xff, 0xc0, 0x00, 0x11, 0x08]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

const gif = (w: number, h: number): Buffer => {
  const b = Buffer.alloc(13);
  b.write("GIF89a", 0, "latin1");
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
};

describe("AttachmentStore", () => {
  it("sniffs the type from magic bytes and reads the pixel size", () => {
    expect(sniffImage(png(3, 2))).toBe("image/png");
    expect(sniffImage(jpeg(640, 480))).toBe("image/jpeg");
    expect(sniffImage(gif(5, 6))).toBe("image/gif");
    const webp = Buffer.alloc(30);
    webp.write("RIFF", 0, "latin1");
    webp.write("WEBPVP8X", 8, "latin1");
    webp.writeUIntLE(99, 24, 3);
    webp.writeUIntLE(49, 27, 3);
    expect(sniffImage(webp)).toBe("image/webp");
    expect(imageSize(webp, "image/webp")).toEqual({ width: 100, height: 50 });
    expect(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeUndefined();
    expect(sniffImage(Buffer.from("GIF8"))).toBeUndefined();
    expect(imageSize(png(3, 2), "image/png")).toEqual({ width: 3, height: 2 });
    expect(imageSize(jpeg(640, 480), "image/jpeg")).toEqual({ width: 640, height: 480 });
    expect(imageSize(gif(5, 6), "image/gif")).toEqual({ width: 5, height: 6 });
  });

  it("stores by sha256 (dedupe), cleans names, rejects bad ids", () => {
    const home = tempDir("ruah-att-");
    const store = new AttachmentStore(home);
    const a = store.save("p1", png(3, 2), "../../etc/Screen Shot.png");
    expect(a).toMatchObject({ name: "Screen Shot.png", mimeType: "image/png", width: 3, height: 2 });
    expect(a.id).toMatch(/^[a-f0-9]{64}\.png$/);
    const b = store.save("p1", png(3, 2), null);
    expect(b.id).toBe(a.id);
    expect(b.name).toBe("image.png");
    expect(readdirSync(path.join(home, "projects", "p1", "attachments"))).toEqual([a.id]);
    expect(store.read("p1", a.id)?.mimeType).toBe("image/png");
    expect(store.read("p2", a.id)).toBeUndefined(); // other project
    expect(store.read("p1", "../../projects.json")).toBeUndefined();
    expect(store.file("p1", `${"a".repeat(64)}.svg`)).toBeUndefined();
    expect(attachmentName("a\u0000b\nc.png", "image/png")).toBe("abc.png");
    expect(() => store.save("p1", Buffer.from("hello"))).toThrow(/not a PNG/);
  });
});

// ---------- hub + HTTP ----------

class ImageBridge implements AcpBridge {
  state: AgentState = "stopped";
  images: boolean | undefined = true;
  lastBlocks: ContentBlock[] = [];
  private readonly listeners = new Set<(event: BridgeEvent) => void>();
  private turn: { turnId: string; resolve: (r: { stopReason: StopReason }) => void } | undefined;

  async start(): Promise<void> {
    this.state = "idle";
    this.emit({ type: "status", state: "idle", agent: { name: "img-agent", version: "1" }, sessionId: "s1" });
  }
  status(): AgentState {
    return this.state;
  }
  supportsImages(): boolean | undefined {
    return this.images;
  }
  prompt(turnId: string, blocks: ContentBlock[]): TurnHandle {
    this.lastBlocks = blocks;
    const done = new Promise<{ stopReason: StopReason }>((resolve) => {
      this.turn = { turnId, resolve };
    });
    this.state = "busy";
    this.emit({ type: "status", state: "busy" });
    return { turnId, done };
  }
  finish(): void {
    const turn = this.turn;
    if (turn === undefined) return;
    this.turn = undefined;
    this.state = "idle";
    this.emit({ type: "stream", turnId: turn.turnId, event: { kind: "text", text: "RUAH-42" } });
    this.emit({ type: "turn_finished", turnId: turn.turnId, stopReason: "end_turn" });
    this.emit({ type: "status", state: "idle" });
    turn.resolve({ stopReason: "end_turn" });
  }
  async cancel(): Promise<void> {}
  answerPermission(): boolean {
    return false;
  }
  async setMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  async reset(): Promise<void> {}
  async stop(): Promise<void> {
    this.state = "stopped";
  }
  on(listener: (event: BridgeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: BridgeEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: ServerMessage[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
  receive(message: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }
  errors(): Extract<ServerMessage, { type: "error" }>[] {
    return this.sent.flatMap((m) => (m.type === "error" ? [m] : []));
  }
}

const store = {
  root: "/repo",
  path: "/repo/architecture.json",
  revision: 0,
  current: () => ({ version: 1, name: "fixture", nodes: [{ id: "api", name: "API", type: "service" }], edges: [], workflows: [] }),
  onChange: () => () => {},
  onError: () => () => {},
  close: () => {},
} as unknown as ArchitectureStore;

const PROJECT = { id: "abcdef012345", name: "fixture", root: "/repo", kind: "repo" as const, lastOpenedAt: "2026-09-23T10:00:00.000Z" };

class Switcher implements AgentSwitcher {
  choices(currentAgentId: string): AgentChoiceState {
    return { currentAgentId, available: [{ id: "alpha", name: "Alpha Agent", installed: true }] };
  }
  check(): { ok: true } {
    return { ok: true };
  }
  create(): AcpBridge {
    return new ImageBridge();
  }
}

async function setup(opts: { images?: boolean | undefined; project?: boolean } = {}) {
  const home = tempDir("ruah-home-");
  const attachments = new AttachmentStore(home);
  const chats = new ChatStore(home);
  const bridge = new ImageBridge();
  bridge.images = "images" in opts ? opts.images : true;
  const withProject = opts.project !== false;
  const hub = new SessionHub(withProject ? store : null, withProject ? bridge : null, {
    version: "0.0.0-test",
    links: false,
    debug: () => {},
    info: () => {},
    agentId: "alpha",
    agents: new Switcher(),
    chats,
    attachments,
    project: PROJECT,
  });
  if (withProject) await bridge.start();
  const server = await startServer(null, hub, { host: "127.0.0.1", port: 0, allowOrigins: [], logger: () => {} });
  cleanups.push(async () => {
    await hub.shutdown();
    await server.close();
  });
  const socket = new FakeSocket();
  attachSession(hub, socket as unknown as WebSocket);
  socket.receive({ type: "hello", protocol: 1, client: "test/0" });
  return { url: server.url, hub, home, bridge, socket, chats, attachments };
}

const upload = (url: string, body: Uint8Array, type = "image/png", name = "shot.png", origin?: string) =>
  fetch(`${url}/api/attachments?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": type, ...(origin !== undefined ? { origin } : {}) },
    body,
  });

describe("attachments HTTP", () => {
  it("uploads, dedupes by hash and serves the image with safe headers", async () => {
    const { url, home } = await setup();
    const res = await upload(url, png(4, 3), "image/png", "Screen Shot 2026.png", "http://localhost:5173");
    expect(res.status).toBe(200);
    const info = (await res.json()) as { id: string; name: string; mimeType: string; size: number; width?: number; height?: number };
    expect(info).toMatchObject({ name: "Screen Shot 2026.png", mimeType: "image/png", width: 4, height: 3, size: png(4, 3).length });
    expect(existsSync(path.join(home, "projects", PROJECT.id, "attachments", info.id))).toBe(true);

    const again = (await (await upload(url, png(4, 3), "image/png", "copy.png")).json()) as { id: string; name: string };
    expect(again.id).toBe(info.id);
    expect(again.name).toBe("copy.png");
    expect(readdirSync(path.join(home, "projects", PROJECT.id, "attachments"))).toHaveLength(1);

    const got = await fetch(`${url}/api/attachments/${info.id}`);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await got.arrayBuffer()).equals(png(4, 3))).toBe(true);
  });

  it("sniffs the real type and rejects non-images and wrong content types", async () => {
    const { url } = await setup();
    // Declared PNG, actually a JPEG: stored as what the bytes say.
    const jpg = (await (await upload(url, jpeg(10, 20), "image/png")).json()) as { id: string; mimeType: string; width: number };
    expect(jpg.id).toMatch(/\.jpg$/);
    expect(jpg).toMatchObject({ mimeType: "image/jpeg", width: 10, height: 20 });
    const got = await fetch(`${url}/api/attachments/${jpg.id}`);
    expect(got.headers.get("content-type")).toBe("image/jpeg");
    // Declared PNG, actually HTML/SVG text.
    const html = await upload(url, Buffer.from("<html><script>alert(1)</script></html>"), "image/png");
    expect(html.status).toBe(415);
    // Not an allowed Content-Type at all.
    expect((await upload(url, png(1, 1), "image/svg+xml")).status).toBe(415);
    expect((await upload(url, png(1, 1), "application/octet-stream")).status).toBe(415);
    expect((await upload(url, Buffer.alloc(0), "image/png")).status).toBe(400);
  });

  it("rejects images over 10 MB", async () => {
    const { url, home } = await setup();
    const res = await upload(url, png(1, 1, 10 * 1024 * 1024), "image/png");
    expect(res.status).toBe(413);
    expect(existsSync(path.join(home, "projects", PROJECT.id, "attachments"))).toBe(false);
  });

  it("validates ids (no traversal) and answers 404 for unknown images", async () => {
    const { url, home } = await setup();
    writeFileSync(path.join(home, "secret.txt"), "secret");
    for (const bad of ["..%2F..%2F..%2Fsecret.txt", "..%2Fchats", `${"a".repeat(64)}.svg`, `${"A".repeat(64)}.png`, "x.png"]) {
      const res = await fetch(`${url}/api/attachments/${bad}`);
      expect(res.status, bad).toBe(400);
    }
    expect((await fetch(`${url}/api/attachments/${"a".repeat(64)}.png`)).status).toBe(404);
  });

  it("checks the Origin on upload (403) and needs an open project (409)", async () => {
    const { url } = await setup();
    const res = await upload(url, png(1, 1), "image/png", "x.png", "https://evil.example");
    expect(res.status).toBe(403);
    const launcher = await setup({ project: false });
    expect((await upload(launcher.url, png(1, 1))).status).toBe(409);
    expect((await upload(launcher.url, png(1, 1), "image/png", "x.png", "https://evil.example")).status).toBe(403);
    expect((await fetch(`${launcher.url}/api/attachments/${"a".repeat(64)}.png`)).status).toBe(409);
  });
});

describe("prompts with attachments", () => {
  it("sends image blocks before the text, announces and stores them with the turn", async () => {
    const { hub, bridge, socket, chats, attachments } = await setup();
    const a = attachments.save(PROJECT.id, png(4, 3), "one.png");
    const b = attachments.save(PROJECT.id, jpeg(8, 8), "two.jpg");
    socket.receive({
      type: "prompt",
      turnId: "t1",
      nodeId: "api",
      text: "What text is in the image?",
      attachments: [
        { id: a.id, name: "one.png" },
        { id: b.id, name: "two.jpg" },
      ],
    });
    expect(socket.errors()).toEqual([]);
    expect(bridge.lastBlocks.map((block) => block.type)).toEqual(["image", "image", "text"]);
    expect(bridge.lastBlocks[0]).toEqual({ type: "image", mimeType: "image/png", data: png(4, 3).toString("base64") });
    expect(bridge.lastBlocks[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    const last = bridge.lastBlocks.at(-1);
    expect(last?.type === "text" && last.text.endsWith("What text is in the image?")).toBe(true);
    const started = socket.sent.find((m) => m.type === "turn.started");
    expect(started).toMatchObject({
      attachments: [
        { id: a.id, name: "one.png", mimeType: "image/png" },
        { id: b.id, name: "two.jpg", mimeType: "image/jpeg" },
      ],
    });

    bridge.finish();
    const chatId = hub.chatId();
    expect(chatId).not.toBeNull();
    const history = chats.history(PROJECT.id, chatId!);
    expect(history).toHaveLength(1);
    expect(history[0]?.attachments).toEqual([
      { id: a.id, name: "one.png", mimeType: "image/png" },
      { id: b.id, name: "two.jpg", mimeType: "image/jpeg" },
    ]);
    // Reopening the chat replays them in chat.history.
    socket.receive({ type: "chat.open", chatId });
    const replay = socket.sent.filter((m) => m.type === "chat.history").at(-1);
    expect(replay?.type === "chat.history" && replay.turns[0]?.attachments?.[0]?.id).toBe(a.id);
  });

  it("a prompt without attachments is unchanged (no attachments field)", async () => {
    const { bridge, socket } = await setup();
    socket.receive({ type: "prompt", turnId: "t1", nodeId: "api", text: "hi" });
    expect(bridge.lastBlocks.map((block) => block.type)).toEqual(["text"]);
    const started = socket.sent.find((m) => m.type === "turn.started");
    expect(started).toBeDefined();
    expect(started !== undefined && "attachments" in started).toBe(false);
  });

  it("rejects images for an agent that cannot read them (and when support is unknown)", async () => {
    for (const images of [false, undefined]) {
      const { bridge, socket, attachments, hub } = await setup({ images });
      const a = attachments.save(PROJECT.id, png(1, 1), "x.png");
      socket.receive({ type: "prompt", turnId: "t1", nodeId: "api", text: "look", attachments: [{ id: a.id, name: "x.png" }] });
      expect(socket.errors()).toEqual([
        { type: "error", code: "bad_message", message: "Alpha Agent can't read images — switch to Claude Code or remove the image", turnId: "t1" },
      ]);
      expect(bridge.lastBlocks).toEqual([]);
      expect(hub.activeTurnId()).toBeUndefined();
    }
  });

  it("agent.status tells the viewer whether the current agent takes images", async () => {
    const yes = await setup({ images: true });
    const status = yes.socket.sent.filter((m) => m.type === "agent.status").at(-1);
    expect(status).toMatchObject({ agents: { available: [{ id: "alpha", images: true }] } });
    const no = await setup({ images: false });
    const status2 = no.socket.sent.filter((m) => m.type === "agent.status").at(-1);
    expect(status2).toMatchObject({ agents: { available: [{ id: "alpha", images: false }] } });
  });

  it("reports a missing attachment file and validates the prompt frame", async () => {
    const { socket } = await setup();
    socket.receive({ type: "prompt", turnId: "t1", nodeId: "api", text: "x", attachments: [{ id: `${"b".repeat(64)}.png`, name: "gone.png" }] });
    expect(socket.errors().at(-1)).toMatchObject({ code: "bad_message", message: "attachment not found: gone.png — attach it again", turnId: "t1" });
    const tooMany = Array.from({ length: 9 }, (_, i) => ({ id: `${String(i).repeat(64)}.png`, name: `${i}.png` }));
    expect(ClientMessageSchema.safeParse({ type: "prompt", turnId: "t", nodeId: "api", text: "x", attachments: tooMany }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ type: "prompt", turnId: "t", nodeId: "api", text: "x", attachments: [{ id: "../x.png", name: "x" }] }).success).toBe(false);
    socket.receive({ type: "prompt", turnId: "t2", nodeId: "api", text: "x", attachments: tooMany });
    expect(socket.errors().at(-1)?.message).toMatch(/at most 8 images per prompt/);
  });
});
