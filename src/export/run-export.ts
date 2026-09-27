// `ruah app export drawio <repo> [--out <file>]` — writes the architecture as
// a draw.io file. Reads <repo>/architecture.json (or the given .json file),
// <repo>/.ruah/links.json and the cached cloud sync in ~/.ruah (RUAH_HOME);
// never touches the network. `--out -` prints to stdout. With a <repo>/product.json,
// a page per customer journey is added (CONTRACTS §23.7).
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { validateArchitecture } from "../contracts/validate.js";
import { ruahHome } from "../usage/log.js";
import { drawioFileName, toDrawio } from "./drawio.js";
import { extrasFromDisk } from "./extras.js";

const USAGE = "usage: ruah app export drawio <repo> [--out <file>]\n";

export async function runExport(argv: readonly string[], version: string): Promise<number> {
  const err = (m: string): number => {
    process.stderr.write(`ruah app export: ${m}\n`);
    return 2;
  };
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: { out: { type: "string" } }, allowPositionals: true, strict: true });
  } catch (e) {
    return err((e as Error).message);
  }
  const [format, target] = parsed.positionals;
  if (format !== "drawio") {
    process.stderr.write(USAGE);
    return 2;
  }
  if (target === undefined) return err("missing <repo> argument");
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) return err(`not found: ${target}`);
  const isFile = fs.statSync(abs).isFile();
  const root = isFile ? path.dirname(abs) : abs;
  const file = isFile ? abs : path.join(root, "architecture.json");
  if (!fs.existsSync(file)) return err(`no architecture.json in ${target} (run \`ruah app scan ${target}\` first)`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    process.stderr.write(`ruah app export: cannot read ${file}: ${(e as Error).message}\n`);
    return 1;
  }
  const result = validateArchitecture(raw, null);
  if (!result.ok) {
    process.stderr.write(`ruah app export: ${file} is invalid:\n  ${result.errors.join("\n  ")}\n`);
    return 1;
  }
  const arch = result.value;
  const extras = extrasFromDisk(root, arch, ruahHome());
  // CONTRACTS §23.7: a page per journey when the repo has a product.json.
  const { loadProduct } = await import("../product/run-journeys.js");
  const loaded = await loadProduct(root);
  const notes = [...(extras.notes ?? []), ...(loaded.errors.length > 0 ? [`product.json is invalid, journeys not included: ${loaded.errors[0] ?? ""}`] : [])];
  const xml = toDrawio(arch, {
    ...extras,
    notes,
    rootName: path.basename(root),
    agent: `ruah ${version}`,
    ...(loaded.product !== null ? { product: loaded.product, productWarnings: loaded.warnings } : {}),
  });
  const out = parsed.values.out;
  if (out === "-") {
    // Wait for the flush: the CLI calls process.exit() next, and pipes are asynchronous on macOS.
    await new Promise<void>((resolve, reject) => process.stdout.write(xml, (e) => (e ? reject(e) : resolve())));
    return 0;
  }
  const dest = path.resolve(out ?? drawioFileName(arch.name));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, xml);
  fs.renameSync(tmp, dest);
  const pages = (xml.match(/<diagram /g) ?? []).length;
  const journeys = loaded.product?.journeys.length ?? 0;
  process.stderr.write(`ruah app export: wrote ${dest} (${pages} pages, ${arch.nodes.length} elements, ${arch.edges.length} links${journeys > 0 ? `, ${journeys} journey${journeys === 1 ? "" : "s"}` : ""})\n`);
  return 0;
}
