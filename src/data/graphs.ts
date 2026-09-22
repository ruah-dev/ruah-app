export type NodeKind =
  // compute
  | "service"
  | "function"
  | "container"
  | "cluster"
  | "worker"
  // data
  | "database"
  | "cache"
  | "storage"
  | "warehouse"
  | "search"
  // messaging
  | "queue"
  | "topic"
  | "stream"
  | "webhook"
  | "scheduler"
  // edge + network
  | "gateway"
  | "loadbalancer"
  | "cdn"
  | "dns"
  | "firewall"
  // platform
  | "auth"
  | "secret"
  | "monitoring"
  | "analytics"
  | "config"
  | "ml"
  // clients
  | "frontend"
  | "mobile"
  | "user"
  | "external"
  // code
  | "module"
  | "file"
  | "api"
  // workflow
  | "step"
  | "decision"
  | "event"
  | "timer"
  | "approval"
  | "actor";

export type CodeFile = {
  repo: string;
  branch: string;
  path: string;
  lang: string;
  code: string;
  highlight?: [number, number];
  deps?: string[];
};

export type DiagramNode = {
  id: string;
  label: string;
  subtitle?: string;
  kind: NodeKind;
  x: number;
  y: number;
  w?: number;
  h?: number;
  drill?: string;
  description?: string;
  owner?: string;
  tech?: string[];
  endpoints?: string[];
  health?: { label: string; tone: "ok" | "warn" | "bad" }[];
  files?: CodeFile[];
  /** Fields carried over from architecture.json (see src/lib/architecture.ts). */
  type?: string;
  path?: string;
  notes?: string;
  layer?: string;
  parent?: string;
  filePaths?: string[];
};

export type DiagramEdge = {
  from: string;
  to: string;
  label?: string;
  animated?: boolean;
  kind?: string;
};

export type DiagramGroup = {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type Graph = {
  id: string;
  title: string;
  subtitle: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  groups?: DiagramGroup[];
};

const sampleRouteCode = `import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { createInvoice, listInvoices } from "./invoices.service";

export const invoicesRouter = Router();

const CreateInvoice = z.object({
  customerId: z.string().uuid(),
  amountCents: z.number().int().positive(),
  currency: z.enum(["EUR", "USD"]),
});

invoicesRouter.get("/invoices", requireAuth, async (req, res) => {
  const invoices = await listInvoices(req.user.orgId);
  res.json({ data: invoices });
});

invoicesRouter.post("/invoices", requireAuth, async (req, res) => {
  const body = CreateInvoice.parse(req.body);
  const invoice = await createInvoice(req.user.orgId, body);
  res.status(201).json({ data: invoice });
});`;

const sampleServiceCode = `import { publish } from "../lib/queue";
import { invoiceRepo } from "./invoices.repo";
import type { NewInvoice } from "./invoices.types";

export async function listInvoices(orgId: string) {
  return invoiceRepo.findByOrg(orgId, { limit: 100 });
}

export async function createInvoice(orgId: string, input: NewInvoice) {
  const invoice = await invoiceRepo.insert({ ...input, orgId, status: "draft" });
  await publish("invoice.created", { invoiceId: invoice.id, orgId });
  return invoice;
}`;

const sampleRepoCode = `import { sql } from "../lib/db";

export const invoiceRepo = {
  async findByOrg(orgId: string, opts: { limit: number }) {
    return sql\`
      select id, customer_id, amount_cents, currency, status, created_at
      from invoices
      where org_id = \${orgId}
      order by created_at desc
      limit \${opts.limit}
    \`;
  },

  async insert(row: Record<string, unknown>) {
    const [created] = await sql\`
      insert into invoices \${sql(row)} returning *
    \`;
    return created;
  },
};`;

const sampleHookCode = `import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

export function useInvoices() {
  return useQuery({
    queryKey: ["invoices"],
    queryFn: () => api.get("/invoices"),
    staleTime: 30_000,
  });
}`;

const sampleComponentCode = `import { useInvoices } from "@/hooks/use-invoices";
import { DataTable } from "@/components/data-table";

export function InvoiceTable() {
  const { data, isLoading } = useInvoices();

  if (isLoading) return <TableSkeleton rows={8} />;

  return <DataTable rows={data.data} columns={invoiceColumns} />;
}`;

export const graphs: Record<string, Graph> = {
  system: {
    id: "system",
    title: "System topology",
    subtitle: "acme/platform · main · 6 services, 3 datastores",
    groups: [
      { id: "g-clients", label: "Clients", x: 24, y: 24, w: 280, h: 220 },
      { id: "g-cloud", label: "AWS · eu-west-1", x: 360, y: 16, w: 800, h: 520 },
      { id: "g-ext", label: "Third parties", x: 24, y: 300, w: 280, h: 236 },
    ],
    nodes: [
      {
        id: "web",
        label: "web-app",
        subtitle: "React · TanStack",
        kind: "frontend",
        x: 48,
        y: 68,
        drill: "frontend-internals",
        description: "Customer-facing dashboard. Renders invoices, billing and org settings.",
        owner: "Team Surface",
        tech: ["React 19", "TanStack Router", "Tailwind"],
        health: [
          { label: "build passing", tone: "ok" },
          { label: "LCP 1.4s", tone: "ok" },
        ],
      },
      {
        id: "mobile",
        label: "mobile-app",
        subtitle: "React Native",
        kind: "frontend",
        x: 48,
        y: 156,
        description: "Read-only companion app for approvals and notifications.",
        owner: "Team Surface",
        tech: ["React Native", "Expo"],
      },
      {
        id: "gateway",
        label: "api-gateway",
        subtitle: "edge routing · rate limits",
        kind: "gateway",
        x: 388,
        y: 64,
        description: "Terminates TLS, authenticates JWTs and fans requests out to services.",
        owner: "Team Platform",
        tech: ["Envoy", "Cloudflare"],
        endpoints: ["GET /v1/*", "POST /v1/*"],
        health: [
          { label: "p95 82ms", tone: "ok" },
          { label: "0.02% 5xx", tone: "ok" },
        ],
      },
      {
        id: "auth",
        label: "auth-service",
        subtitle: "sessions · tokens",
        kind: "service",
        x: 388,
        y: 176,
        description: "Issues and rotates access tokens, owns org membership checks.",
        owner: "Team Platform",
        tech: ["Go", "Postgres"],
        endpoints: ["POST /token", "POST /token/refresh"],
      },
      {
        id: "api",
        label: "invoices-api",
        subtitle: "Node · Express",
        kind: "service",
        x: 660,
        y: 64,
        drill: "backend-internals",
        description:
          "Core business service. Handles invoice CRUD, validation and emits domain events.",
        owner: "Team Billing",
        tech: ["Node 22", "Express", "Zod", "Postgres"],
        endpoints: ["GET /invoices", "POST /invoices", "POST /invoices/:id/send"],
        health: [
          { label: "p95 210ms", tone: "warn" },
          { label: "deploy 2h ago", tone: "ok" },
        ],
      },
      {
        id: "billing",
        label: "billing-service",
        subtitle: "pricing · tax",
        kind: "service",
        x: 660,
        y: 176,
        description: "Calculates line items, VAT and settlement against the payment provider.",
        owner: "Team Billing",
        tech: ["Node 22", "Postgres"],
      },
      {
        id: "queue",
        label: "events-bus",
        subtitle: "invoice.* topics",
        kind: "queue",
        x: 660,
        y: 288,
        description: "Durable pub/sub between services. Retries with exponential backoff.",
        owner: "Team Platform",
        tech: ["SQS", "SNS"],
        health: [{ label: "1.2k msg/min", tone: "ok" }],
      },
      {
        id: "worker",
        label: "notify-worker",
        subtitle: "email · webhooks",
        kind: "service",
        x: 660,
        y: 400,
        description: "Consumes domain events and delivers email plus outbound webhooks.",
        owner: "Team Growth",
        tech: ["Node 22", "Resend"],
        health: [{ label: "queue lag 4s", tone: "warn" }],
      },
      {
        id: "pg",
        label: "postgres",
        subtitle: "primary + replica",
        kind: "database",
        x: 932,
        y: 64,
        description: "Primary relational store. 42 tables, row-level security enabled.",
        owner: "Team Platform",
        tech: ["Postgres 16", "PgBouncer"],
      },
      {
        id: "redis",
        label: "redis",
        subtitle: "cache · locks",
        kind: "database",
        x: 932,
        y: 176,
        description: "Session cache, idempotency keys and distributed locks.",
        owner: "Team Platform",
        tech: ["Redis 7"],
      },
      {
        id: "blob",
        label: "object-store",
        subtitle: "invoice PDFs",
        kind: "database",
        x: 932,
        y: 288,
        description: "Generated PDF documents and export archives.",
        owner: "Team Billing",
        tech: ["S3"],
      },
      {
        id: "stripe",
        label: "Stripe",
        subtitle: "payments",
        kind: "external",
        x: 48,
        y: 344,
        description: "Charges, refunds and payout reconciliation webhooks.",
        tech: ["REST", "Webhooks"],
      },
      {
        id: "jira",
        label: "Jira Cloud",
        subtitle: "delivery workflow",
        kind: "external",
        x: 48,
        y: 432,
        drill: "workflow-jira",
        description: "Issue tracker driving the delivery workflow for this codebase.",
        tech: ["REST", "Webhooks"],
      },
    ],
    edges: [
      { from: "web", to: "gateway", label: "https", animated: true },
      { from: "mobile", to: "gateway", label: "https" },
      { from: "gateway", to: "auth", label: "verify" },
      { from: "gateway", to: "api", label: "/v1/invoices", animated: true },
      { from: "gateway", to: "billing", label: "/v1/billing" },
      { from: "api", to: "pg", label: "sql" },
      { from: "api", to: "redis", label: "cache" },
      { from: "api", to: "queue", label: "publish", animated: true },
      { from: "billing", to: "pg", label: "sql" },
      { from: "billing", to: "stripe", label: "charge" },
      { from: "queue", to: "worker", label: "consume", animated: true },
      { from: "worker", to: "blob", label: "store pdf" },
      { from: "auth", to: "redis", label: "sessions" },
    ],
  },

  "backend-internals": {
    id: "backend-internals",
    title: "invoices-api · internals",
    subtitle: "src/ · 118 files · request path highlighted",
    groups: [
      { id: "g-edge", label: "HTTP edge", x: 24, y: 24, w: 264, h: 400 },
      { id: "g-domain", label: "Domain", x: 328, y: 24, w: 264, h: 400 },
      { id: "g-data", label: "Data access", x: 632, y: 24, w: 528, h: 400 },
    ],
    nodes: [
      {
        id: "http-in",
        label: "incoming request",
        subtitle: "from api-gateway",
        kind: "external",
        x: 48,
        y: 64,
        description: "Every request arrives here with a verified JWT and a request id.",
      },
      {
        id: "routes",
        label: "routes/",
        subtitle: "12 route modules",
        kind: "module",
        x: 48,
        y: 176,
        drill: "routes-module",
        description: "Express routers. One file per resource, all mounted in app.ts.",
        owner: "Team Billing",
        endpoints: ["GET /invoices", "POST /invoices"],
      },
      {
        id: "middleware",
        label: "middleware/",
        subtitle: "auth · logging · errors",
        kind: "module",
        x: 48,
        y: 288,
        description: "Cross-cutting request handling: auth, request logging, error mapping.",
      },
      {
        id: "controllers",
        label: "handlers/",
        subtitle: "request → command",
        kind: "module",
        x: 352,
        y: 120,
        description: "Thin adapters: parse input with Zod, call domain services, shape responses.",
      },
      {
        id: "domain",
        label: "services/",
        subtitle: "business rules",
        kind: "module",
        x: 352,
        y: 256,
        description: "Invoice lifecycle rules, numbering, state transitions and event emission.",
      },
      {
        id: "repos",
        label: "repositories/",
        subtitle: "sql access",
        kind: "module",
        x: 656,
        y: 120,
        drill: "routes-module",
        description: "Every SQL statement in the service lives behind these repository objects.",
      },
      {
        id: "models",
        label: "models/",
        subtitle: "types · schemas",
        kind: "module",
        x: 656,
        y: 256,
        description: "Zod schemas and TypeScript types shared by handlers and services.",
      },
      {
        id: "db-conn",
        label: "lib/db.ts",
        subtitle: "pooled client",
        kind: "database",
        x: 932,
        y: 120,
        description: "Postgres pool with statement timeouts and query logging.",
      },
      {
        id: "queue-lib",
        label: "lib/queue.ts",
        subtitle: "event publisher",
        kind: "queue",
        x: 932,
        y: 256,
        description: "Publishes domain events to the events bus with an outbox guarantee.",
      },
    ],
    edges: [
      { from: "http-in", to: "routes", animated: true },
      { from: "routes", to: "middleware", label: "guards" },
      { from: "routes", to: "controllers", label: "dispatch", animated: true },
      { from: "controllers", to: "domain", label: "invoke", animated: true },
      { from: "controllers", to: "models", label: "validate" },
      { from: "domain", to: "repos", label: "persist", animated: true },
      { from: "domain", to: "queue-lib", label: "emit" },
      { from: "repos", to: "db-conn", label: "sql" },
      { from: "repos", to: "models", label: "map rows" },
    ],
  },

  "routes-module": {
    id: "routes-module",
    title: "invoices route module",
    subtitle: "src/routes/invoices · 5 files · call graph",
    nodes: [
      {
        id: "f-app",
        label: "app.ts",
        subtitle: "mounts routers",
        kind: "file",
        x: 48,
        y: 56,
        files: [
          {
            repo: "acme/platform",
            branch: "main",
            path: "services/invoices-api/src/app.ts",
            lang: "typescript",
            code: `import express from "express";
import { invoicesRouter } from "./routes/invoices/invoices.routes";
import { errorHandler } from "./middleware/errors";

export const app = express();

app.use(express.json({ limit: "1mb" }));
app.use("/v1", invoicesRouter);
app.use(errorHandler);`,
            highlight: [8, 8],
            deps: ["express", "./routes/invoices/invoices.routes"],
          },
        ],
      },
      {
        id: "f-routes",
        label: "invoices.routes.ts",
        subtitle: "GET / POST /invoices",
        kind: "file",
        x: 48,
        y: 200,
        description: "Declares the HTTP surface for invoices and validates request bodies.",
        endpoints: ["GET /invoices", "POST /invoices"],
        files: [
          {
            repo: "acme/platform",
            branch: "main",
            path: "services/invoices-api/src/routes/invoices/invoices.routes.ts",
            lang: "typescript",
            code: sampleRouteCode,
            highlight: [18, 22],
            deps: ["zod", "../../middleware/auth", "./invoices.service"],
          },
        ],
      },
      {
        id: "f-guard",
        label: "auth.ts",
        subtitle: "requireAuth()",
        kind: "file",
        x: 48,
        y: 344,
        files: [
          {
            repo: "acme/platform",
            branch: "main",
            path: "services/invoices-api/src/middleware/auth.ts",
            lang: "typescript",
            code: `import type { RequestHandler } from "express";
import { verifyToken } from "../lib/tokens";

export const requireAuth: RequestHandler = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return res.status(401).end();

  const claims = await verifyToken(header.slice(7));
  req.user = { id: claims.sub, orgId: claims.org_id };
  next();
};`,
            highlight: [5, 6],
          },
        ],
      },
      {
        id: "f-service",
        label: "invoices.service.ts",
        subtitle: "business rules",
        kind: "file",
        x: 400,
        y: 128,
        description: "Creates invoices, publishes invoice.created and reads by org.",
        files: [
          {
            repo: "acme/platform",
            branch: "main",
            path: "services/invoices-api/src/routes/invoices/invoices.service.ts",
            lang: "typescript",
            code: sampleServiceCode,
            highlight: [9, 12],
            deps: ["../lib/queue", "./invoices.repo"],
          },
        ],
      },
      {
        id: "f-repo",
        label: "invoices.repo.ts",
        subtitle: "sql statements",
        kind: "file",
        x: 400,
        y: 288,
        description: "All invoice SQL. Parameterised queries only.",
        files: [
          {
            repo: "acme/platform",
            branch: "main",
            path: "services/invoices-api/src/routes/invoices/invoices.repo.ts",
            lang: "typescript",
            code: sampleRepoCode,
            highlight: [4, 13],
            deps: ["../lib/db"],
          },
        ],
      },
      {
        id: "f-types",
        label: "invoices.types.ts",
        subtitle: "schemas",
        kind: "file",
        x: 748,
        y: 208,
        files: [
          {
            repo: "acme/platform",
            branch: "main",
            path: "services/invoices-api/src/routes/invoices/invoices.types.ts",
            lang: "typescript",
            code: `export type InvoiceStatus = "draft" | "sent" | "paid" | "void";

export type NewInvoice = {
  customerId: string;
  amountCents: number;
  currency: "EUR" | "USD";
};`,
          },
        ],
      },
    ],
    edges: [
      { from: "f-app", to: "f-routes", label: "mount", animated: true },
      { from: "f-guard", to: "f-routes", label: "guards" },
      { from: "f-routes", to: "f-service", label: "calls", animated: true },
      { from: "f-service", to: "f-repo", label: "calls", animated: true },
      { from: "f-service", to: "f-types", label: "types" },
      { from: "f-repo", to: "f-types", label: "types" },
    ],
  },

  "frontend-internals": {
    id: "frontend-internals",
    title: "web-app · internals",
    subtitle: "src/ · 214 files · data path highlighted",
    groups: [
      { id: "g-shell", label: "Routing shell", x: 24, y: 24, w: 264, h: 400 },
      { id: "g-view", label: "View layer", x: 328, y: 24, w: 264, h: 400 },
      { id: "g-data-fe", label: "Data layer", x: 632, y: 24, w: 528, h: 400 },
    ],
    nodes: [
      {
        id: "fe-root",
        label: "__root.tsx",
        subtitle: "shell · providers",
        kind: "file",
        x: 48,
        y: 64,
        description: "App shell, query provider and global chrome.",
      },
      {
        id: "fe-routes",
        label: "routes/",
        subtitle: "18 routes",
        kind: "module",
        x: 48,
        y: 200,
        description: "File-based routes. Loaders prefetch queries before render.",
      },
      {
        id: "fe-pages",
        label: "pages/invoices",
        subtitle: "screen composition",
        kind: "module",
        x: 352,
        y: 96,
        description: "Composes the invoices screen from table, filters and detail drawer.",
      },
      {
        id: "fe-components",
        label: "components/",
        subtitle: "design system",
        kind: "module",
        x: 352,
        y: 248,
        drill: "frontend-module",
        description: "Reusable presentation components built on shadcn primitives.",
      },
      {
        id: "fe-hooks",
        label: "hooks/",
        subtitle: "query hooks",
        kind: "module",
        x: 656,
        y: 96,
        drill: "frontend-module",
        description: "TanStack Query hooks wrapping every server read and write.",
      },
      {
        id: "fe-api",
        label: "lib/api-client.ts",
        subtitle: "fetch wrapper",
        kind: "file",
        x: 656,
        y: 248,
        description: "Typed fetch client: base URL, auth header, error normalisation.",
      },
      {
        id: "fe-gateway",
        label: "api-gateway",
        subtitle: "/v1",
        kind: "gateway",
        x: 932,
        y: 172,
        description: "The single network boundary the frontend talks to.",
      },
    ],
    edges: [
      { from: "fe-root", to: "fe-routes", label: "outlet" },
      { from: "fe-routes", to: "fe-pages", label: "render", animated: true },
      { from: "fe-pages", to: "fe-components", label: "compose" },
      { from: "fe-pages", to: "fe-hooks", label: "read", animated: true },
      { from: "fe-hooks", to: "fe-api", label: "fetch", animated: true },
      { from: "fe-api", to: "fe-gateway", label: "https", animated: true },
    ],
  },

  "frontend-module": {
    id: "frontend-module",
    title: "invoices feature module",
    subtitle: "src/hooks + src/components · 4 files",
    nodes: [
      {
        id: "fe-f-route",
        label: "invoices.tsx",
        subtitle: "route file",
        kind: "file",
        x: 48,
        y: 88,
        files: [
          {
            repo: "acme/platform",
            branch: "main",
            path: "apps/web/src/routes/invoices.tsx",
            lang: "tsx",
            code: `import { createFileRoute } from "@tanstack/react-router";
import { InvoiceTable } from "@/components/invoice-table";

export const Route = createFileRoute("/invoices")({
  component: InvoicesPage,
});

function InvoicesPage() {
  return <InvoiceTable />;
}`,
            highlight: [4, 6],
          },
        ],
      },
      {
        id: "fe-f-table",
        label: "invoice-table.tsx",
        subtitle: "component",
        kind: "file",
        x: 400,
        y: 88,
        files: [
          {
            repo: "acme/platform",
            branch: "main",
            path: "apps/web/src/components/invoice-table.tsx",
            lang: "tsx",
            code: sampleComponentCode,
            highlight: [5, 5],
            deps: ["@/hooks/use-invoices", "@/components/data-table"],
          },
        ],
      },
      {
        id: "fe-f-hook",
        label: "use-invoices.ts",
        subtitle: "query hook",
        kind: "file",
        x: 748,
        y: 88,
        files: [
          {
            repo: "acme/platform",
            branch: "main",
            path: "apps/web/src/hooks/use-invoices.ts",
            lang: "typescript",
            code: sampleHookCode,
            highlight: [5, 10],
            deps: ["@tanstack/react-query", "@/lib/api-client"],
          },
        ],
      },
      {
        id: "fe-f-client",
        label: "api-client.ts",
        subtitle: "transport",
        kind: "file",
        x: 400,
        y: 264,
        files: [
          {
            repo: "acme/platform",
            branch: "main",
            path: "apps/web/src/lib/api-client.ts",
            lang: "typescript",
            code: `const BASE = import.meta.env.VITE_API_URL ?? "/v1";

async function request(path: string, init?: RequestInit) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json();
}

export const api = {
  get: (path: string) => request(path),
  post: (path: string, body: unknown) =>
    request(path, { method: "POST", body: JSON.stringify(body) }),
};`,
            highlight: [8, 8],
          },
        ],
      },
    ],
    edges: [
      { from: "fe-f-route", to: "fe-f-table", label: "renders", animated: true },
      { from: "fe-f-table", to: "fe-f-hook", label: "useInvoices()", animated: true },
      { from: "fe-f-hook", to: "fe-f-client", label: "api.get()", animated: true },
    ],
  },

  "workflow-jira": {
    id: "workflow-jira",
    title: "Delivery workflow · Jira",
    subtitle: "PLAT board · ticket lifecycle and handoffs",
    groups: [
      { id: "l1", label: "Product", x: 24, y: 24, w: 1136, h: 128 },
      { id: "l2", label: "Engineering", x: 24, y: 168, w: 1136, h: 128 },
      { id: "l3", label: "Review & release", x: 24, y: 312, w: 1136, h: 128 },
    ],
    nodes: [
      {
        id: "w-intake",
        label: "Intake",
        subtitle: "request captured",
        kind: "step",
        x: 56,
        y: 60,
        description: "Anyone files a request. Product triages within one working day.",
        owner: "Product",
      },
      {
        id: "w-backlog",
        label: "Backlog",
        subtitle: "estimated · ranked",
        kind: "step",
        x: 336,
        y: 60,
        description: "Refined ticket with acceptance criteria and an estimate.",
        owner: "Product",
      },
      {
        id: "w-sprint",
        label: "Selected for sprint",
        subtitle: "committed",
        kind: "step",
        x: 616,
        y: 60,
        description: "Pulled into the active sprint during planning.",
        owner: "Product + Eng",
      },
      {
        id: "w-progress",
        label: "In progress",
        subtitle: "branch open",
        kind: "step",
        x: 56,
        y: 204,
        drill: "workflow-request",
        description: "Branch created from the ticket key. Drill in for the request lifecycle.",
        owner: "Engineering",
      },
      {
        id: "w-pr",
        label: "In review",
        subtitle: "pull request",
        kind: "step",
        x: 336,
        y: 204,
        description: "PR opened, CI green required, one approval minimum.",
        owner: "Engineering",
      },
      {
        id: "w-qa",
        label: "QA",
        subtitle: "preview env",
        kind: "step",
        x: 616,
        y: 204,
        description: "Tested on the per-PR preview environment against the criteria.",
        owner: "QA",
      },
      {
        id: "w-blocked",
        label: "Blocked",
        subtitle: "waiting",
        kind: "external",
        x: 896,
        y: 204,
        description: "Any state can move here. Requires a blocker reason and an owner.",
      },
      {
        id: "w-staging",
        label: "Staging",
        subtitle: "merged to main",
        kind: "step",
        x: 56,
        y: 348,
        description: "Merged and auto-deployed to staging.",
        owner: "Engineering",
      },
      {
        id: "w-release",
        label: "Release",
        subtitle: "prod deploy",
        kind: "step",
        x: 336,
        y: 348,
        description: "Progressive rollout with automatic rollback on error budget burn.",
        owner: "Team Platform",
      },
      {
        id: "w-done",
        label: "Done",
        subtitle: "verified in prod",
        kind: "step",
        x: 616,
        y: 348,
        description: "Verified in production, ticket closed and release notes updated.",
      },
    ],
    edges: [
      { from: "w-intake", to: "w-backlog", label: "triage", animated: true },
      { from: "w-backlog", to: "w-sprint", label: "planning" },
      { from: "w-sprint", to: "w-progress", label: "start", animated: true },
      { from: "w-progress", to: "w-pr", label: "open PR", animated: true },
      { from: "w-pr", to: "w-qa", label: "approved" },
      { from: "w-qa", to: "w-staging", label: "pass", animated: true },
      { from: "w-qa", to: "w-progress", label: "reject" },
      { from: "w-staging", to: "w-release", label: "cut", animated: true },
      { from: "w-release", to: "w-done", label: "verify" },
      { from: "w-pr", to: "w-blocked", label: "blocked" },
    ],
  },

  "workflow-request": {
    id: "workflow-request",
    title: "Request lifecycle",
    subtitle: "POST /v1/invoices · end to end",
    nodes: [
      { id: "r-client", label: "Browser", subtitle: "form submit", kind: "external", x: 48, y: 72 },
      { id: "r-edge", label: "Edge", subtitle: "TLS · rate limit", kind: "gateway", x: 320, y: 72 },
      { id: "r-auth", label: "Auth check", subtitle: "JWT verify", kind: "service", x: 320, y: 208 },
      {
        id: "r-validate",
        label: "Validate",
        subtitle: "Zod schema",
        kind: "module",
        x: 592,
        y: 72,
      },
      {
        id: "r-domain",
        label: "Create invoice",
        subtitle: "domain rules",
        kind: "module",
        x: 592,
        y: 208,
      },
      { id: "r-db", label: "Insert row", subtitle: "postgres", kind: "database", x: 864, y: 72 },
      { id: "r-event", label: "Emit event", subtitle: "invoice.created", kind: "queue", x: 864, y: 208 },
      { id: "r-resp", label: "201 Created", subtitle: "json body", kind: "step", x: 864, y: 344 },
    ],
    edges: [
      { from: "r-client", to: "r-edge", label: "POST", animated: true },
      { from: "r-edge", to: "r-auth", label: "verify" },
      { from: "r-edge", to: "r-validate", label: "forward", animated: true },
      { from: "r-validate", to: "r-domain", label: "parsed", animated: true },
      { from: "r-domain", to: "r-db", label: "insert" },
      { from: "r-domain", to: "r-event", label: "publish", animated: true },
      { from: "r-domain", to: "r-resp", label: "respond" },
    ],
  },
};

export const architectureRoots = [
  { id: "system", label: "System topology", hint: "services, datastores, third parties" },
  { id: "backend-internals", label: "invoices-api internals", hint: "backend code layers" },
  { id: "frontend-internals", label: "web-app internals", hint: "frontend code layers" },
];

export const workflowRoots = [
  { id: "workflow-jira", label: "Jira delivery flow", hint: "intake → done" },
  { id: "workflow-request", label: "Request lifecycle", hint: "POST /v1/invoices" },
];

export type RepoTreeNode = {
  name: string;
  kind: "dir" | "file";
  children?: RepoTreeNode[];
  nodeId?: string;
  graphId?: string;
};

export const repoTree: RepoTreeNode[] = [
  {
    name: "apps",
    kind: "dir",
    children: [
      {
        name: "web",
        kind: "dir",
        children: [
          { name: "src/routes", kind: "dir", graphId: "frontend-internals", nodeId: "fe-routes" },
          { name: "src/components", kind: "dir", graphId: "frontend-module", nodeId: "fe-f-table" },
          { name: "src/hooks", kind: "dir", graphId: "frontend-module", nodeId: "fe-f-hook" },
          { name: "src/lib/api-client.ts", kind: "file", graphId: "frontend-module", nodeId: "fe-f-client" },
        ],
      },
    ],
  },
  {
    name: "services",
    kind: "dir",
    children: [
      {
        name: "invoices-api",
        kind: "dir",
        children: [
          { name: "src/app.ts", kind: "file", graphId: "routes-module", nodeId: "f-app" },
          { name: "src/routes", kind: "dir", graphId: "routes-module", nodeId: "f-routes" },
          { name: "src/middleware", kind: "dir", graphId: "routes-module", nodeId: "f-guard" },
          { name: "src/repositories", kind: "dir", graphId: "routes-module", nodeId: "f-repo" },
        ],
      },
      { name: "auth-service", kind: "dir", graphId: "system", nodeId: "auth" },
      { name: "billing-service", kind: "dir", graphId: "system", nodeId: "billing" },
      { name: "notify-worker", kind: "dir", graphId: "system", nodeId: "worker" },
    ],
  },
  {
    name: "infra",
    kind: "dir",
    children: [
      { name: "terraform", kind: "dir", graphId: "system", nodeId: "gateway" },
      { name: "queues.tf", kind: "file", graphId: "system", nodeId: "queue" },
    ],
  },
];
