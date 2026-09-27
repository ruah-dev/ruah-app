// `ruah app journeys` (CONTRACTS §23.7): the customer journeys of product.json without
// the app. Reads <root>/product.json and <root>/architecture.json (a system folder
// works too: expanded ids resolve through ruah.system.json); never writes them.
//   list [--json]                      journeys with persona, priority, steps and gap counts
//   show <id>                          the ruah_get_product text for one journey
//   export <id>|--all [--format html|md|drawio] [--out <file>|-] [--no-shots]
// Exit codes: 0 ok, 1 unreadable/invalid product.json or write failure, 2 usage errors
// (unknown option, unknown journey, missing argument).
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import type { Architecture } from "../contracts/architecture.js";
import { PRODUCT_FILE, type Journey, type ProductFile, validateProduct } from "../contracts/product.js";
import { createArchitectureStore } from "../serve/architecture-store.js";
import { touchResolverFor } from "../serve/product-touches.js";
import { exportJourneys, isJourneyExportFormat, loadScreenshots, type JourneyExportFormat } from "./export.js";
import { summarizeProduct } from "./read.js";
import { findJourney } from "./share.js";

export const JOURNEYS_USAGE = `usage: ruah app journeys [--root <dir>] [list] [--json]
       ruah app journeys [--root <dir>] show <id>
       ruah app journeys [--root <dir>] export <id>|--all [--format html|md|drawio] [--out <file>|-] [--no-shots]

  list      journeys with persona, priority, steps and gaps (missing why on core
            journeys, open questions, broken links)
  show      one journey as text: steps, screens, touches, questions, warnings
  export    a storyboard (html, self-contained, opens offline), markdown for a PR
            (md) or draw.io swimlanes (drawio); --all = every journey in one file.
            Default --out: <id>.storyboard.html / <id>.md / <id>.drawio in the
            current folder; --out - prints to stdout. --md / --html / --drawio are
            short for --format. Screenshots (.ruah/shots) are embedded in html
            unless --no-shots.
  --root    the project folder holding product.json (default: current folder)
`;

export interface LoadedProduct {
  root: string;
  product: ProductFile | null;
  architecture: Architecture | null;
  warnings: string[];
  /** Why product.json could not be used (invalid JSON or contract errors). */
  errors: string[];
}

function systemResolver(root: string): Promise<((rel: string) => { abs: string; root: string } | null) | undefined> {
  if (!fs.existsSync(path.join(root, "ruah.system.json"))) return Promise.resolve(undefined);
  return import("../system/config.js").then(
    ({ loadSystem, resolveSystemPath }) => {
      try {
        const sys = loadSystem(root);
        return (rel: string) => {
          const hit = resolveSystemPath(sys, rel);
          return hit === null ? null : { abs: hit.abs, root: hit.root };
        };
      } catch {
        return undefined;
      }
    },
    () => undefined,
  );
}

/** product.json + the architecture (for touch resolution and broken links), read once, no watchers. */
export async function loadProduct(rootDir: string): Promise<LoadedProduct> {
  const root = path.resolve(rootDir);
  const out: LoadedProduct = { root, product: null, architecture: null, warnings: [], errors: [] };
  const file = path.join(root, PRODUCT_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return out;
    out.errors.push(`cannot read ${file}: ${(err as Error).message}`);
    return out;
  }
  const archPath = path.join(root, "architecture.json");
  let resolveTouch: ((ref: string) => boolean) | undefined;
  let close = (): void => {};
  if (fs.existsSync(archPath)) {
    const resolvePath = await systemResolver(root);
    const store = createArchitectureStore(archPath, { watch: false, ...(resolvePath !== undefined ? { resolvePath } : {}) });
    store.onError(() => {}); // an invalid map: journeys still export, touches unresolved
    await store.load();
    out.architecture = store.current();
    resolveTouch = touchResolverFor(store);
    close = () => store.close();
  }
  try {
    const result = validateProduct(raw, { root, ...(resolveTouch !== undefined ? { resolveTouch } : {}) });
    if (!result.ok) out.errors.push(...result.errors);
    else {
      out.product = result.value;
      out.warnings = result.warnings;
    }
  } finally {
    close();
  }
  return out;
}

export interface JourneyGaps {
  /** core journeys only: the journey's why plus every step's why that is missing. */
  missingWhy: number;
  openQuestions: number;
  brokenLinks: number;
}

export function journeyGaps(journey: Journey, warnings: readonly string[]): JourneyGaps {
  const core = journey.priority === "core";
  return {
    missingWhy: core ? (journey.why === undefined ? 1 : 0) + journey.steps.filter((s) => s.why === undefined).length : 0,
    openQuestions: journey.steps.filter((s) => s.question !== undefined).length,
    brokenLinks: warnings.filter((w) => w.startsWith(`journey ${journey.id}: `) && w.includes(": broken link: ")).length,
  };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function gapText(g: JourneyGaps): string {
  const parts = [
    g.missingWhy > 0 ? `${plural(g.missingWhy, "missing why", "missing whys")}` : "",
    g.openQuestions > 0 ? plural(g.openQuestions, "open question") : "",
    g.brokenLinks > 0 ? plural(g.brokenLinks, "broken link") : "",
  ].filter((s) => s !== "");
  return parts.length === 0 ? "no gaps" : parts.join(", ");
}

async function write(text: string): Promise<void> {
  // Wait for the flush: the CLI calls process.exit() next, and pipes are asynchronous on macOS.
  await new Promise<void>((resolve, reject) => process.stdout.write(text, (e) => (e ? reject(e) : resolve())));
}

export async function runJourneys(argv: readonly string[], version: string): Promise<number> {
  const err = (m: string, code = 2): number => {
    process.stderr.write(`ruah app journeys: ${m}\n`);
    return code;
  };
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        root: { type: "string" },
        json: { type: "boolean", default: false },
        format: { type: "string" },
        out: { type: "string" },
        all: { type: "boolean", default: false },
        html: { type: "boolean", default: false },
        md: { type: "boolean", default: false },
        drawio: { type: "boolean", default: false },
        "no-shots": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    return err((e as Error).message);
  }
  const { values, positionals } = parsed;
  const [sub = "list", id, ...extra] = positionals;
  if (values.help === true || sub === "help") {
    await write(JOURNEYS_USAGE);
    return 0;
  }
  if (!["list", "show", "export"].includes(sub)) {
    process.stderr.write(JOURNEYS_USAGE);
    return err(`unknown subcommand "${sub}"`);
  }
  if (extra.length > 0) return err(`unexpected argument: ${extra.join(" ")}`);
  const rootDir = values.root ?? ".";
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) return err(`not a folder: ${rootDir}`);

  const loaded = await loadProduct(rootDir);
  if (loaded.errors.length > 0) return err(`${path.join(loaded.root, PRODUCT_FILE)} is invalid:\n  ${loaded.errors.join("\n  ")}`, 1);
  const product = loaded.product;

  if (sub === "list") {
    if (id !== undefined) return err(`unexpected argument: ${id}`);
    const rows = (product?.journeys ?? []).map((j) => ({
      id: j.id,
      name: j.name,
      persona: j.persona !== undefined ? (product?.personas.find((p) => p.id === j.persona)?.name ?? j.persona) : null,
      priority: j.priority ?? null,
      steps: j.steps.length,
      gaps: journeyGaps(j, loaded.warnings),
    }));
    if (values.json === true) {
      await write(`${JSON.stringify({ root: loaded.root, product: product !== null, journeys: rows }, null, 2)}\n`);
      return 0;
    }
    if (product === null) {
      await write(`No journeys yet: no ${PRODUCT_FILE} in ${loaded.root}. Map one in the app (Journeys) or ask an agent to.\n`);
      return 0;
    }
    const width = Math.min(28, Math.max(0, ...rows.map((r) => r.id.length)));
    const lines = rows.map((r) =>
      `  ${r.id.padEnd(width)}  ${[r.name, r.persona, r.priority, plural(r.steps, "step")].filter((x): x is string => x !== null).join(" · ")} · ${gapText(r.gaps)}`,
    );
    await write(`${plural(rows.length, "journey")} in ${loaded.root}${rows.length > 0 ? ":" : ""}\n${lines.map((l) => `${l}\n`).join("")}`);
    return 0;
  }

  if (product === null) return err(`no ${PRODUCT_FILE} in ${loaded.root}`, 1);

  if (sub === "show") {
    if (id === undefined) return err("missing <id> argument");
    const journey = findJourney(product, id);
    if (journey === undefined) return err(`unknown journey "${id}" (journeys: ${product.journeys.map((j) => j.id).join(", ") || "none"})`);
    const warnings = loaded.warnings.filter((w) => w.startsWith(`journey ${journey.id}: `));
    await write(`${summarizeProduct(product, warnings, journey.id)}\n`);
    return 0;
  }

  // export
  const shorthands = (["html", "md", "drawio"] as const).filter((f) => values[f] === true);
  if (shorthands.length > 1 || (shorthands.length === 1 && values.format !== undefined && values.format !== shorthands[0])) return err("pick one format");
  const format = values.format ?? shorthands[0] ?? "html";
  if (!isJourneyExportFormat(format)) return err(`unknown --format "${format}" (expected html, md or drawio)`);
  if (values.all === true && id !== undefined) return err("give a journey id or --all, not both");
  if (values.all !== true && id === undefined) return err("missing <id> argument (or --all)");
  if (id !== undefined && findJourney(product, id) === undefined) {
    return err(`unknown journey "${id}" (journeys: ${product.journeys.map((j) => j.id).join(", ") || "none"})`);
  }
  const result = exportJourneys(format as JourneyExportFormat, {
    product,
    architecture: loaded.architecture,
    ...(id !== undefined ? { journeyId: id } : {}),
    warnings: loaded.warnings,
    ...(format === "html" && values["no-shots"] !== true ? { screenshots: loadScreenshots(loaded.root, product) } : {}),
    projectName: loaded.architecture?.name ?? path.basename(loaded.root),
    agent: `ruah ${version}`,
  });
  if (values.out === "-") {
    await write(result.body);
    return 0;
  }
  const dest = path.resolve(values.out ?? result.fileName);
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, result.body);
    fs.renameSync(tmp, dest);
  } catch (e) {
    return err(`cannot write ${dest}: ${(e as Error).message}`, 1);
  }
  const count = id !== undefined ? 1 : product.journeys.length;
  process.stderr.write(`ruah app journeys: wrote ${dest} (${format}, ${plural(count, "journey")})\n`);
  return 0;
}
