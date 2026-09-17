import { parseArgs } from "node:util";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const USAGE = `archmap — architecture map daemon

Usage:
  archmap serve <repo> [options]   serve the viewer + agent daemon
  archmap scan <repo> [options]    scan a repo into architecture.json
  archmap mcp <repo>               stdio MCP server
  archmap --version                print version
  archmap help                     this text

serve options:
  --file <path>            architecture file (default <repo>/architecture.json)
  --port <n>               port to listen on (default 4177)
  --host <addr>            bind address (default 127.0.0.1)
  --viewer <dir>           static viewer directory (default ./viewer)
  --mock                   run the scripted mock agent instead of Claude Code
  --allow-origin <glob>    extra allowed websocket origin (repeatable)
  --no-links               omit resource_link blocks from prompts
  --open                   open the viewer URL in the default browser
`;

async function serve(argv: readonly string[]): Promise<number> {
  // Pull the positional <repo> out first: parseArgs with strict:false mangles
  // a bare positional that follows a boolean flag.
  const repoIndex = argv.findIndex((a) => !a.startsWith("--"));
  const repo = repoIndex === -1 ? undefined : argv[repoIndex];
  const rest = repoIndex === -1 ? [...argv] : argv.filter((_, i) => i !== repoIndex);
  const { values } = parseArgs({
    args: [...rest],
    options: {
      file: { type: "string" },
      port: { type: "string", default: "4177" },
      host: { type: "string", default: "127.0.0.1" },
      viewer: { type: "string", default: "viewer" },
      mock: { type: "boolean", default: false },
      "allow-origin": { type: "string", multiple: true, default: [] },
      links: { type: "boolean", default: true },
      open: { type: "boolean", default: false },
    },
    strict: false,
  });
  if (repo === undefined) {
    process.stderr.write("archmap serve: missing <repo> argument\n");
    return 2;
  }
  const { runServe } = await import("./serve/run-serve.js");
  return runServe(
    {
      repo,
      ...(typeof values.file === "string" ? { file: values.file } : {}),
      port: Number.parseInt(values.port as string, 10),
      host: values.host as string,
      viewer: values.viewer as string,
      mock: values.mock === true,
      allowOrigins: ((values["allow-origin"] as string[] | undefined) ?? []).filter(
        (o): o is string => typeof o === "string",
      ),
      links: values.links !== false,
      open: values.open === true,
    },
    pkg.version,
  );
}

async function main(argv: readonly string[]): Promise<number> {
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
    case "serve": {
      return await serve(rest);
    }
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
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}

export { main };
