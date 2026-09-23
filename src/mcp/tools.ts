// src/mcp/tools.ts — the ruah_* map tools (CONTRACTS §1.7), defined once and
// served two ways: in-process to the Claude Agent SDK (sdk-server.ts,
// createSdkMcpServer) and over stdio to ACP agents (`archmap mcp`,
// stdio-server.ts). A tool either reads the architecture or turns its
// arguments into ArchOps; a MapBackend does the actual work (the daemon's
// MapOpsService in-process, or its HTTP API from the stdio process), so every
// write is validated, saved atomically and broadcast by the daemon.
import { z } from "zod/v4";
import type { Architecture } from "../contracts/architecture.js";
import type { ArchOp, ArchOpsResponse } from "../contracts/map.js";
import { KNOWN_TYPES } from "./ops.js";
import { describeElement, findElements, summarizeArchitecture } from "./read.js";

export const MAP_SERVER_NAME = "ruah";

/** Shown to the agent (MCP server instructions, system prompt, context pack). */
export const MAP_TOOLS_HINT =
  "You can read and edit this project's architecture map with the ruah_* tools; keep it in sync when you add or change services, modules, datastores or links.";

export const MAP_SERVER_INSTRUCTIONS = `${MAP_TOOLS_HINT} The user watches the map update live while you work. Read first (ruah_get_architecture, ruah_find_elements, ruah_get_element), then edit (ruah_add_element, ruah_update_element, ruah_remove_element, ruah_connect, ruah_disconnect, ruah_add_workflow, ruah_update_workflow, or ruah_apply for several changes at once). Elements are referenced by id or by their exact name. Only these tools change the map: never edit architecture.json by hand.`;

/** What a tool needs from the daemon. */
export interface MapBackend {
  read(): Promise<{ architecture: Architecture; revision: number }>;
  apply(ops: ArchOp[]): Promise<ArchOpsResponse>;
}

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** An error the agent should read and fix (bad reference, validation failure …). */
export class MapToolError extends Error {}

// ---------- argument shapes (zod v4: the SDK's tool() takes them, and z.toJSONSchema lists them for stdio) ----------

const ref = (what: string) => z.string().min(1).describe(`${what}: element id, or its exact name when that is unique`);
const typeDoc = `Element type. Known: ${KNOWN_TYPES.join(", ")} (others render as module).`;

const elementFields = {
  name: z.string().min(1).describe("Display name, e.g. \"Payments service\""),
  type: z.string().min(1).describe(typeDoc),
  layer: z.string().optional().describe("Layer / band, e.g. services, data, external (added to the layer list if new)"),
  parent: z.string().optional().describe("Id or name of the containing element (omit for the top level)"),
  path: z.string().optional().describe("Repo-relative directory or file the element lives in"),
  tech: z.array(z.string()).optional().describe("Technologies, e.g. [\"Node 22\", \"Stripe SDK\"]"),
  description: z.string().optional().describe("1–2 sentences, at most 400 chars"),
  notes: z.string().optional().describe("Longer notes (markdown)"),
  files: z.array(z.string()).optional().describe("Up to 20 repo-relative files, most relevant first"),
};

const patchFields = {
  name: z.string().optional(),
  type: z.string().optional().describe(typeDoc),
  layer: z.string().nullable().optional().describe("null clears it"),
  parent: z.string().nullable().optional().describe("Id or name of the new parent; null moves it to the top level"),
  path: z.string().nullable().optional().describe("null clears it"),
  tech: z.array(z.string()).nullable().optional().describe("Replaces the list; null clears it"),
  description: z.string().nullable().optional().describe("At most 400 chars; null clears it"),
  notes: z.string().nullable().optional().describe("null clears it"),
  files: z.array(z.string()).nullable().optional().describe("Replaces the list; null clears it"),
};

const connectFields = {
  from: ref("Source element"),
  to: ref("Target element"),
  label: z.string().optional().describe("Short label on the link, at most 40 chars (e.g. \"payments\", \"REST\", \"order.created\")"),
  kind: z.string().optional().describe("sync | async | event | data"),
};

const opSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_element"), id: z.string().optional(), ...elementFields }),
  z.object({ op: z.literal("update_element"), id: ref("Element"), patch: z.object(patchFields) }),
  z.object({ op: z.literal("remove_element"), id: ref("Element"), recursive: z.boolean().optional() }),
  z.object({ op: z.literal("connect"), ...connectFields }),
  z.object({ op: z.literal("disconnect"), from: ref("Source element"), to: ref("Target element"), label: z.string().optional() }),
  z.object({ op: z.literal("add_workflow"), id: z.string().optional(), name: z.string(), description: z.string().optional(), steps: z.array(z.string()).min(2) }),
  z.object({
    op: z.literal("update_workflow"),
    id: z.string(),
    name: z.string().optional(),
    description: z.string().nullable().optional(),
    steps: z.array(z.string()).min(2).optional(),
  }),
  z.object({ op: z.literal("remove_workflow"), id: z.string() }),
  z.object({ op: z.literal("set_layout_hint"), id: ref("Element"), x: z.number(), y: z.number() }),
]);

type Shape = Record<string, z.ZodType>;

export interface MapToolDef {
  name: string;
  description: string;
  shape: Shape;
  readOnly: boolean;
  run(args: Record<string, unknown>, backend: MapBackend): Promise<string>;
}

async function write(backend: MapBackend, ops: ArchOp[]): Promise<string> {
  const res = await backend.apply(ops);
  const lines = res.results.map((r) => `- ${r.message}`);
  if (res.warnings.length > 0) lines.push(`notes: ${res.warnings.slice(0, 5).join("; ")}`);
  return `${lines.join("\n")}\n(map saved, revision ${res.revision})`;
}

const strip = <T extends Record<string, unknown>>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export const MAP_TOOLS: readonly MapToolDef[] = [
  {
    name: "ruah_get_architecture",
    description:
      "Read the project's architecture map: elements (id, name, type, layer, parent, path) and links. Pass `level` (an element id) to list only what is inside that element, or \"\" for the top level; omit it for every level.",
    shape: { level: z.string().optional().describe("Element id whose inside to list; \"\" = top level; omit = all levels") },
    readOnly: true,
    async run(args, backend) {
      const { architecture } = await backend.read();
      return summarizeArchitecture(architecture, args.level as string | undefined);
    },
  },
  {
    name: "ruah_get_element",
    description: "Everything about one element: all fields, its parent and children, incoming and outgoing links, workflows it is part of, files.",
    shape: { id: ref("Element") },
    readOnly: true,
    async run(args, backend) {
      const { architecture } = await backend.read();
      return describeElement(architecture, String(args.id));
    },
  },
  {
    name: "ruah_find_elements",
    description: "Search elements by name, id, path, tech or description (all words must match). Optional type filter.",
    shape: {
      query: z.string().describe("Words to look for, e.g. \"payment\" or \"src/api\""),
      type: z.string().optional().describe("Only this element type"),
      limit: z.number().int().min(1).max(100).optional(),
    },
    readOnly: true,
    async run(args, backend) {
      const { architecture } = await backend.read();
      return findElements(architecture, String(args.query ?? ""), { type: args.type as string | undefined, limit: args.limit as number | undefined });
    },
  },
  {
    name: "ruah_add_element",
    description:
      "Add an element (service, module, datastore, external system, queue, frontend …) to the map. The id is derived from the name unless given. Use `parent` to put it inside another element. Link it with ruah_connect.",
    shape: { id: z.string().optional().describe("Optional id (lowercase, digits, . _ -); default: from the name"), ...elementFields },
    readOnly: false,
    run: (args, backend) => write(backend, [{ op: "add_element", ...(strip(args) as Omit<Extract<ArchOp, { op: "add_element" }>, "op">) }]),
  },
  {
    name: "ruah_update_element",
    description: "Change fields of an element (the id stays). Only the fields you pass change; null clears an optional field.",
    shape: { id: ref("Element"), ...patchFields },
    readOnly: false,
    run: (args, backend) => {
      const { id, ...patch } = args;
      return write(backend, [{ op: "update_element", id: String(id), patch: strip(patch) }]);
    },
  },
  {
    name: "ruah_remove_element",
    description: "Remove an element with its links. Refused when it has elements inside, unless recursive is true.",
    shape: { id: ref("Element"), recursive: z.boolean().optional().describe("Also remove everything inside it") },
    readOnly: false,
    run: (args, backend) =>
      write(backend, [{ op: "remove_element", id: String(args.id), ...(args.recursive === true ? { recursive: true } : {}) }]),
  },
  {
    name: "ruah_connect",
    description: "Draw a link from one element to another (e.g. a service calling a database or an external API). Idempotent.",
    shape: connectFields,
    readOnly: false,
    run: (args, backend) => write(backend, [{ op: "connect", ...(strip(args) as { from: string; to: string }) }]),
  },
  {
    name: "ruah_disconnect",
    description: "Remove the link(s) from one element to another (only the one with `label` when given).",
    shape: { from: ref("Source element"), to: ref("Target element"), label: z.string().optional() },
    readOnly: false,
    run: (args, backend) => write(backend, [{ op: "disconnect", ...(strip(args) as { from: string; to: string }) }]),
  },
  {
    name: "ruah_add_workflow",
    description: "Add a workflow: an ordered path through elements (e.g. a request flow), at least 2 steps.",
    shape: {
      id: z.string().optional(),
      name: z.string(),
      description: z.string().optional(),
      steps: z.array(z.string()).min(2).describe("Element ids or names, in order"),
    },
    readOnly: false,
    run: (args, backend) =>
      write(backend, [{ op: "add_workflow", ...(strip(args) as { name: string; steps: string[] }) }]),
  },
  {
    name: "ruah_update_workflow",
    description: "Rename a workflow, change its description or replace its steps.",
    shape: {
      id: z.string().describe("Workflow id or name"),
      name: z.string().optional(),
      description: z.string().nullable().optional(),
      steps: z.array(z.string()).min(2).optional(),
    },
    readOnly: false,
    run: (args, backend) => write(backend, [{ op: "update_workflow", ...(strip(args) as { id: string }) }]),
  },
  {
    name: "ruah_apply",
    description:
      "Apply several map changes at once, atomically (all or nothing, one save the user sees as one update). Ops: add_element, update_element {id, patch}, remove_element, connect, disconnect, add_workflow, update_workflow, remove_workflow, set_layout_hint {id, x, y}. Later ops can reference elements added by earlier ones (by name or id).",
    shape: { ops: z.array(opSchema).min(1).max(200) },
    readOnly: false,
    run: (args, backend) => write(backend, args.ops as ArchOp[]),
  },
];

/** Runs a tool; errors become a tool result with isError so the agent can correct itself. */
export async function callMapTool(name: string, args: unknown, backend: MapBackend): Promise<ToolResult> {
  const tool = MAP_TOOLS.find((t) => t.name === name);
  if (tool === undefined) return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
  const parsed = z.object(tool.shape).safeParse(args ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`).join("; ");
    return { content: [{ type: "text", text: `invalid arguments: ${issues}` }], isError: true };
  }
  try {
    const text = await tool.run(parsed.data as Record<string, unknown>, backend);
    return { content: [{ type: "text", text }] };
  } catch (err) {
    return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
}

/** tools/list entries (JSON Schema input) for the stdio server. */
export function mapToolList(): { name: string; description: string; inputSchema: Record<string, unknown>; annotations: Record<string, unknown> }[] {
  return MAP_TOOLS.map((t) => {
    const { $schema: _drop, ...schema } = z.toJSONSchema(z.object(t.shape), { io: "input" }) as Record<string, unknown>;
    return {
      name: t.name,
      description: t.description,
      inputSchema: schema,
      annotations: { readOnlyHint: t.readOnly, destructiveHint: t.name === "ruah_remove_element" || t.name === "ruah_apply", idempotentHint: t.readOnly },
    };
  });
}

/** Fully qualified names as the Claude Agent SDK exposes them ("mcp__ruah__ruah_connect"). */
export function sdkToolNames(): string[] {
  return MAP_TOOLS.map((t) => `mcp__${MAP_SERVER_NAME}__${t.name}`);
}
