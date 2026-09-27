// src/desktop/run-app-update.ts — `ruah app app-update`: build the checkout's branch and install it
// into the desktop app by hand (src/desktop/self-update.ts does the same by itself once the
// installed app carries a build stamp; this is also how the first stamped build gets installed).
//
//   ruah app app-update [--app /Applications/Ruah.app] [--ref main] [--flavor <f>] [--no-install]
import { execFileSync } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";
import { ruahHome } from "../usage/log.js";
import { SelfUpdater } from "./self-update.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

export async function runAppUpdate(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      app: { type: "string", default: "/Applications/Ruah.app" },
      ref: { type: "string", default: "main" },
      flavor: { type: "string" },
      "no-install": { type: "boolean", default: false },
    },
    strict: true,
  });
  let repo: string;
  try {
    repo = path.dirname(git(process.cwd(), ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  } catch {
    process.stderr.write("ruah app app-update: run it inside the Ruah checkout\n");
    return 2;
  }
  const bundle = path.resolve(values.app as string);
  let appPid: number | undefined;
  try {
    const pid = Number.parseInt(execFileSync("pgrep", ["-f", `^${bundle}/Contents/MacOS/[^/ ]+$`], { encoding: "utf8" }).split("\n")[0] ?? "", 10);
    if (Number.isInteger(pid) && pid > 1) appPid = pid;
  } catch {
    // not running
  }
  let lastStep = "";
  const updater = new SelfUpdater({
    // No stamp to compare with: whatever the ref points at is built.
    info: { commit: "0000000", repo, ref: values.ref as string, dirty: false, builtAt: "" },
    bundle,
    home: ruahHome(),
    ...(typeof values.flavor === "string" ? { flavor: values.flavor } : {}),
    ...(appPid !== undefined ? { appPid } : {}),
    auto: false,
    onStatus: (status) => {
      if (status.phase === "building" && status.step !== undefined && status.step !== lastStep) {
        lastStep = status.step;
        process.stdout.write(`… ${status.step}\n`);
      }
    },
  });
  const checked = await updater.check();
  if (checked.phase === "unsupported") {
    process.stderr.write(`ruah app app-update: ${checked.reason ?? "unsupported"}\n`);
    return 1;
  }
  process.stdout.write(`Building ${values.ref as string} @ ${checked.latest?.slice(0, 7)} ${checked.subject ?? ""}\n`);
  await updater.build();
  const built = updater.snapshot();
  if (built.phase !== "ready") {
    process.stderr.write(`ruah app app-update: ${built.error ?? "the build failed"}\n`);
    return 1;
  }
  if (values["no-install"] === true) {
    process.stdout.write("Staged; it installs when Ruah quits.\n");
    return 0;
  }
  await updater.install(true);
  process.stdout.write(`${appPid !== undefined ? "Restarting" : "Installing and opening"} ${bundle} (log: ${path.join(ruahHome(), "app-update", "swap.log")})\n`);
  return 0;
}
