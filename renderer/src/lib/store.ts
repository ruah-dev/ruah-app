import type {
  AgentState,
  Architecture,
  ErrorCode,
  ModeState,
  PermissionOption,
  ServerMessage,
  StopReason,
  StreamEvent,
  ToolCallView,
} from "./contract/index.js";
import { DaemonSocket, type ConnectionState } from "./daemon.js";

// Viewer store (PLAN.md L2): connection state, architecture, agent status and
// the turn list, driven purely by ServerMessages from the daemon.

export interface PermissionRequest {
  turnId: string;
  requestId: string;
  toolCall: ToolCallView;
  options: PermissionOption[];
}

export interface Turn {
  id: string;
  nodeId: string;
  text: string;
  contextPack: string;
  events: StreamEvent[];
  toolCalls: Map<string, ToolCallView>;
  permission: PermissionRequest | null;
  permissionRecord: string | null;
  stopReason?: StopReason;
  error?: string;
}

export interface DaemonStore {
  connection: ConnectionState;
  architecture: Architecture | null;
  revision: number;
  root: string | null;
  archError: string | null;
  agent: AgentState;
  agentInfo: { name: string; version: string } | null;
  agentError: string | null;
  modes: ModeState | null;
  turns: Turn[];
  lastError: { code: ErrorCode; message: string } | null;
  focus: string | null;
}

type Listener = () => void;

const initial = (): DaemonStore => ({
  connection: "connecting",
  architecture: null,
  revision: 0,
  root: "",
  archError: null,
  agent: "starting",
  agentInfo: null,
  agentError: null,
  modes: null,
  turns: [],
  lastError: null,
  focus: null,
});

export function createStore(url: string) {
  let state: DaemonStore = initial();
  const listeners = new Set<Listener>();

  const emit = (): void => {
    for (const listener of listeners) listener();
  };

  const setState = (patch: Partial<DaemonStore>): void => {
    state = { ...state, ...patch };
    emit();
  };

  const upsertTurn = (turnId: string, fn: (turn: Turn) => Turn): void => {
    setState({
      turns: state.turns.map((t) => (t.id === turnId ? fn(t) : t)),
    });
  };

  const handleMessage = (message: ServerMessage): void => {
    switch (message.type) {
      case "architecture": {
        setState({
          architecture: message.architecture,
          revision: message.revision,
          root: message.root,
          archError: null,
        });
        return;
      }
      case "architecture.error": {
        setState({ archError: message.message });
        return;
      }
      case "agent.status": {
        setState({
          agent: message.state,
          ...(message.agent !== undefined ? { agentInfo: message.agent } : {}),
          ...(message.modes !== undefined ? { modes: message.modes } : {}),
          ...(message.error !== undefined ? { agentError: message.error } : { agentError: null }),
        });
        return;
      }
      case "turn.started": {
        const turn: Turn = {
          id: message.turnId,
          nodeId: message.nodeId,
          text: message.text,
          contextPack: message.contextPack,
          events: [],
          toolCalls: new Map(),
          permission: null,
          permissionRecord: null,
        };
        setState({ turns: [...state.turns, turn] });
        return;
      }
      case "stream": {
        upsertTurn(message.turnId, (turn) => {
          const events = [...turn.events, message.event];
          const toolCalls = new Map(turn.toolCalls);
          if (message.event.kind === "tool_call" || message.event.kind === "tool_result") {
            toolCalls.set(message.event.toolCall.toolCallId, message.event.toolCall);
          }
          return { ...turn, events, toolCalls };
        });
        return;
      }
      case "permission.request": {
        upsertTurn(message.turnId, (turn) => ({
          ...turn,
          permission: {
            turnId: message.turnId,
            requestId: message.requestId,
            toolCall: message.toolCall,
            options: message.options,
          },
        }));
        return;
      }
      case "permission.resolved": {
        upsertTurn(message.turnId, (turn) => {
          if (turn.permission === null || turn.permission.requestId !== message.requestId) {
            return turn;
          }
          const outcome = message.cancelled === true
            ? "dismissed"
            : `allowed: ${message.optionId ?? turn.permission.options[0]?.name ?? ""}`;
          const record = outcome === "dismissed"
            ? `dismissed: ${turn.permission.toolCall.title}`
            : `answered: ${turn.permission.toolCall.title}`;
          return {
            ...turn,
            permission: null,
            permissionRecord: record,
            events: [...turn.events],
          };
        });
        return;
      }
      case "turn.finished": {
        upsertTurn(message.turnId, (turn) => ({
          ...turn,
          stopReason: message.stopReason,
          ...(message.error !== undefined ? { error: message.error } : {}),
          permission: null,
        }));
        return;
      }
      case "error": {
        setState({ lastError: { code: message.code, message: message.message } });
        if (message.turnId !== undefined) {
          upsertTurn(message.turnId, (turn) =>
            turn.stopReason === undefined
              ? { ...turn, stopReason: "error", error: `${message.code}: ${message.message}` }
              : turn,
          );
        }
        return;
      }
    }
  };

  const socket = new DaemonSocket(
    url,
    (connection) => setState({ connection }),
    handleMessage,
  );

  const send = (message: Parameters<DaemonSocket["send"]>[0]): void => {
    socket.send(message);
  };

  return {
    connect: () => socket.connect(),
    close: () => socket.close(),
    send,
    getState: () => state,
    subscribe: (listener: Listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type Store = ReturnType<typeof createStore>;
