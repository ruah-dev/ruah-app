import { parseArgs } from "node:util";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const pkg: { version: string } = require("../package.json");

const USAGE = `archmap — architecture map daemon

Usage:
  archmap serve <repo> [options]   serve the viewer + agent bridge
  archmap scan <repo> [options]    scan a repo into architecture.json
  archmap mcp <repo>               stdio MCP server
  archmap --version                print version
  archmap help                     this text
`;

function main(argv: readonly string[]): number {
  const [cmd, ...rest] = argv;
  if (cmd === "--version" || cmd === "-v") {
    console.log(pkg.version);
    return 0;
  }
  if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(USAGE);
    return cmd === undefined ? 2 : 0;
  }
  switch (cmd) {
    case "serve":
    case "scan":
    case "mcp": {
      parseArgs({ args: rest, strict: false });
      console.log("not implemented");
      return 2;
    }
    default:
      process.stdout.write(USAGE);
      return 2;
  }
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isDirectRun) {
  process.exit(main(process.argv.slice(2)));
}

export { main };
