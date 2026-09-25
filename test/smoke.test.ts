import { afterEach, expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { WebSocket } from "ws";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture(): string {
  const directory = mkdtempSync(resolve("test/.backend-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const repo = join(directory, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "architecture.json"), JSON.stringify({
    version: 1, name: "fixture", nodes: [{ id: "api", name: "API", type: "service" }], edges: [], workflows: [],
  }));
  writeFileSync(join(directory, "outside.txt"), "outside fixture");
  symlinkSync(join(directory, "outside.txt"), join(repo, "linked.txt"));
  return repo;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

// Regression: started by the desktop app (stdout piped, RUAH_PARENT_PID), the daemon logged
// "desktop app is gone" into the closed pipe once the app died; the unhandled EPIPE crashed it
// (exit 1) before it had stopped its agents and terminals.
test("built daemon shuts down cleanly when the desktop app and its pipes are gone", async () => {
  const parent = spawn("sleep", ["1"], { stdio: "ignore" });
  const child = spawn(process.execPath, [resolve("dist/cli.js"), "serve", fixture(), "--mock", "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RUAH_PARENT_PID: String(parent.pid) },
  });
  cleanups.push(() => stop(child));
  await new Promise<void>((resolveUp, reject) => {
    let output = "";
    child.on("exit", (code) => reject(new Error(`daemon exited ${code} before it was up`)));
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("viewer http")) resolveUp();
    });
  });
  child.removeAllListeners("exit");
  // The app vanishes: its end of the pipes closes.
  child.stdout?.destroy();
  child.stderr?.destroy();
  const [code] = (await once(child, "exit")) as [number | null];
  expect(code).toBe(0);
}, 15000);

test("built daemon rejects disallowed origins and out-of-root file symlinks", async () => {
  const child = spawn(process.execPath, [resolve("dist/cli.js"), "serve", fixture(), "--mock", "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  cleanups.push(() => stop(child));
  let output = "";
  let errors = "";
  child.stderr?.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
  const url = await new Promise<string>((resolveUrl, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`daemon exited ${code}: ${errors}`)));
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = /viewer (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match?.[1] !== undefined) resolveUrl(match[1]);
    });
  });
  const ws = new WebSocket(url.replace("http:", "ws:") + "/ws", { origin: "https://untrusted.invalid" });
  const status = await new Promise<number | undefined>((resolveStatus, reject) => {
    ws.on("unexpected-response", (_request, response) => {
      response.resume();
      ws.terminate();
      resolveStatus(response.statusCode);
    });
    ws.on("error", reject);
    ws.on("open", () => { ws.terminate(); reject(new Error("disallowed origin accepted")); });
  });
  expect(status).toBe(403);
  const file = await fetch(`${url}/api/file?path=linked.txt`);
  expect(file.status).toBe(400);
  expect(await file.text()).not.toContain("outside fixture");
}, 10000);
