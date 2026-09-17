import { ClientMessageSchema, ServerMessageSchema } from "./contract/index.js";
import type { ClientMessage, ServerMessage } from "./contract/index.js";

// CONTRACTS.md §2 — typed WebSocket client. hello first, exponential backoff
// reconnect (500 ms → 8 s), unknown daemon frames ignored per the preamble
// convention. The caller owns message semantics.

export type ConnectionState = "connecting" | "open" | "closed";

const CLIENT = "archmap-renderer/0.1.0";
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 8_000;

export class DaemonSocket {
  private socket: WebSocket | null = null;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByCaller = false;
  private readonly url: string;

  constructor(
    url: string,
    private readonly onState: (state: ConnectionState) => void,
    private readonly onMessage: (message: ServerMessage) => void,
  ) {
    this.url = url;
  }

  connect(): void {
    this.closedByCaller = false;
    this.open();
  }

  close(): void {
    this.closedByCaller = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, "viewer closed");
    this.socket = null;
    this.onState("closed");
  }

  send(message: ClientMessage): void {
    const parsed = ClientMessageSchema.safeParse(message);
    if (!parsed.success) return;
    if (this.socket !== null && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(parsed.data));
    }
  }

  private open(): void {
    this.onState("connecting");
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.attempts = 0;
      this.onState("open");
      socket.send(JSON.stringify({ type: "hello", protocol: 1, client: CLIENT } satisfies ClientMessage));
    };
    socket.onmessage = (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }
      const result = ServerMessageSchema.safeParse(parsed);
      if (!result.success) return;
      this.onMessage(result.data);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (!this.closedByCaller) this.scheduleReconnect();
    };
    socket.onerror = () => {
      socket.close();
    };
  }

  private scheduleReconnect(): void {
    this.onState("closed");
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempts);
    this.attempts += 1;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (!this.closedByCaller) this.open();
    }, delay);
  }
}
