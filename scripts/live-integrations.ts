// scripts/live-integrations.ts — manual live check of the read-only
// integration paths against this machine's CLIs. Prints counts only (no
// resource names, IPs or accounts). Usage:
//   RUAH_HOME=$(mktemp -d) pnpm tsx scripts/live-integrations.ts [projectRoot]
import * as path from "node:path";
import { IntegrationsService } from "../src/integrations/index.js";
import { MemorySecretStore } from "../src/integrations/keychain.js";

const home = process.env.RUAH_HOME;
if (home === undefined || home.length === 0) {
  process.stderr.write("set RUAH_HOME to a scratch directory\n");
  process.exit(2);
}
const root = path.resolve(process.argv[2] ?? process.cwd());
const service = new IntegrationsService({
  home,
  project: () => ({ root, architecture: { version: 1, name: "live", nodes: [], edges: [], workflows: [] } }),
  secrets: new MemorySecretStore(),
});

const { integrations } = await service.list();
for (const i of integrations) process.stdout.write(`${i.id.padEnd(13)} ${i.status.padEnd(14)} accounts=${i.accounts?.length ?? 0}\n`);

const started = Date.now();
const sync = await service.cloudSync({ providers: ["digitalocean"] });
const counts = new Map<string, number>();
for (const r of sync.resources) counts.set(`${r.type}/${r.service}`, (counts.get(`${r.type}/${r.service}`) ?? 0) + 1);
process.stdout.write(`\ndigitalocean sync: ${sync.resources.length} resources in ${Date.now() - started} ms\n`);
for (const [key, n] of [...counts].sort()) process.stdout.write(`  ${key.padEnd(28)} ${n}\n`);
for (const e of sync.errors) process.stdout.write(`  error ${e.provider}: ${e.message.replace(/[0-9a-f-]{36}/g, "<id>")}\n`);
const example = sync.resources[0];
if (example !== undefined) {
  const redacted = { ...example, id: example.id.replace(/[^:]+$/, "<redacted>"), name: "<redacted>", consoleUrl: example.consoleUrl?.replace(/[^/]+$/, "<redacted>") };
  process.stdout.write(`  example ${JSON.stringify(redacted)}\n`);
}

process.stdout.write(`\nruah status: ${JSON.stringify(await service.ruahStatus()).slice(0, 200)}\n`);
process.stdout.write(`ruah workflows: ${JSON.stringify(await service.ruahWorkflows())}\n`);
