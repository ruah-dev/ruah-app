// The daemon reports the viewer build it serves (CONTRACTS §2.3 GET /api/health `viewerBuild`):
// read from the <meta name="ruah-build"> of the viewer's index.html, and re-read when a rebuild
// replaces the directory while the daemon runs (a window on an older build then reloads).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "../src/serve/server.js";
import { SessionHub } from "../src/serve/session.js";
import { parseViewerBuildId, viewerBuildId } from "../src/serve/static.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function viewerDir(buildId: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruah-viewer-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeIndex(dir, buildId);
  return dir;
}

function writeIndex(dir: string, buildId: string | null, extra = "") {
  const meta = buildId === null ? "" : `<meta name="ruah-build" content="${buildId}"/>`;
  fs.writeFileSync(
    path.join(dir, "index.html"),
    `<!DOCTYPE html><html><head><meta charSet="utf-8"/><title>Ruah</title>${meta}${extra}</head><body></body></html>`,
  );
}

describe("viewer build id", () => {
  it("parses the ruah-build meta tag in any attribute order", () => {
    expect(parseViewerBuildId('<head><meta name="ruah-build" content="abc-123"/></head>')).toBe("abc-123");
    expect(parseViewerBuildId("<meta content='x9' name='ruah-build'>")).toBe("x9");
    expect(parseViewerBuildId('<meta name="description" content="nope"><meta name="ruah-build" content="">')).toBeNull();
    expect(parseViewerBuildId("<html><head></head></html>")).toBeNull();
  });

  it("reads the served index.html and notices a rebuild", () => {
    const dir = viewerDir("build-1");
    expect(viewerBuildId(dir)).toBe("build-1");
    // A rebuild writes a new index.html (different size here, so the cache cannot hide it).
    writeIndex(dir, "build-two-longer");
    expect(viewerBuildId(dir)).toBe("build-two-longer");
    expect(viewerBuildId(path.join(dir, "missing"))).toBeNull();
    expect(viewerBuildId(undefined)).toBeNull();
  });

  it("GET /api/health reports viewerBuild (null without a viewer build id)", async () => {
    const dir = viewerDir("abc123-x7");
    const hub = new SessionHub(null, null, { version: "0.0.0-test", links: false, debug: () => {}, info: () => {} });
    const server = await startServer(null, hub, { host: "127.0.0.1", port: 0, allowOrigins: [], logger: () => {}, viewerDir: dir });
    cleanups.push(async () => {
      await hub.shutdown();
      await server.close();
    });
    const health = (await (await fetch(`${server.url}/api/health`)).json()) as Record<string, unknown>;
    expect(health).toMatchObject({ ok: true, version: "0.0.0-test", viewerBuild: "abc123-x7" });

    // `pnpm ui:build` replaces the directory while the daemon runs.
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
    writeIndex(dir, "newer-build-id", "<!-- rebuilt -->");
    const after = (await (await fetch(`${server.url}/api/health`)).json()) as Record<string, unknown>;
    expect(after["viewerBuild"]).toBe("newer-build-id");

    const bare = new SessionHub(null, null, { version: "0.0.0-test", links: false, debug: () => {}, info: () => {} });
    const noViewer = await startServer(null, bare, { host: "127.0.0.1", port: 0, allowOrigins: [], logger: () => {} });
    cleanups.push(async () => {
      await bare.shutdown();
      await noViewer.close();
    });
    const none = (await (await fetch(`${noViewer.url}/api/health`)).json()) as Record<string, unknown>;
    expect(none["viewerBuild"]).toBeNull();
  });
});
