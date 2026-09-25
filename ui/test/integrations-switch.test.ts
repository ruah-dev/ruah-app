// The integrations store across a project switch: a load (or sync) that was in flight for the
// previous project must neither stand in for the new project's load nor land in its lists.
// Regression: once("cloud") handed the new project the old project's running request, whose
// answer was then shown as the new project's cloud resources (and the new list never loaded).
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindIntegrationsStore, integrationsSnapshot, loadCloud, syncCloud } from "@/lib/integrations";

type Pending = { url: string; resolve: (body: unknown) => void };

function fakeFetch(): Pending[] {
  const pending: Pending[] = [];
  vi.stubGlobal("fetch", (url: string) =>
    new Promise((resolve) => {
      pending.push({
        url,
        resolve: (body) =>
          resolve({
            ok: true,
            status: 200,
            statusText: "OK",
            headers: { get: () => "application/json" },
            json: async () => body,
          }),
      });
    }),
  );
  return pending;
}

const daemon = (root: string) => ({ source: "daemon" as const, httpOrigin: "http://127.0.0.1:4177", root, connection: "open" as const });
const snapshot = (id: string) => ({ resources: [{ id, provider: "vercel", type: "app", service: "project", name: id }], syncedAt: "t", errors: [] });

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function cloudIds(): string[] | string {
  const { cloud } = integrationsSnapshot();
  return cloud.status === "ok" ? cloud.data.resources.map((r) => r.id) : cloud.status;
}

describe("integrations store: project switch", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a cloud load from the previous project neither blocks nor overwrites the new one", async () => {
    const pending = fakeFetch();
    bindIntegrationsStore(daemon("/a"));
    const loadA = loadCloud();
    bindIntegrationsStore(daemon("/b"));
    const loadB = loadCloud();
    expect(pending).toHaveLength(2); // B asked for its own list
    pending[0]!.resolve(snapshot("from-a"));
    await loadA;
    await flush();
    expect(cloudIds()).not.toEqual(["from-a"]);
    pending[1]!.resolve(snapshot("from-b"));
    await loadB;
    expect(cloudIds()).toEqual(["from-b"]);
  });

  it("a sync answered after a switch is not applied to the new project", async () => {
    const pending = fakeFetch();
    bindIntegrationsStore(daemon("/c"));
    const sync = syncCloud();
    bindIntegrationsStore(daemon("/d"));
    pending[0]!.resolve(snapshot("from-c"));
    await sync;
    expect(cloudIds()).not.toEqual(["from-c"]);
  });
});
