import { describe, expect, test } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArchitectureStore } from "../src/serve/architecture-store.js";
import type { Architecture } from "../src/contracts/architecture.js";

const GOOD: Architecture = {
  version: 1,
  name: "acme-platform",
  nodes: [{ id: "api", type: "service", name: "invoices-api" }],
  edges: [],
  workflows: [],
};

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "archmap-store-"));
  writeFileSync(join(dir, "architecture.json"), JSON.stringify(GOOD));
  return dir;
}

test("load reads, validates, and notifies with reason initial", async () => {
  const dir = tmpRepo();
  const store = createArchitectureStore(join(dir, "architecture.json"));
  const events: unknown[] = [];
  store.onChange((e) => events.push(e));
  await store.load();
  expect(events).toHaveLength(1);
  const first = events[0] as { reason: string; revision: number };
  expect(first.reason).toBe("initial");
  expect(first.revision).toBe(1);
  expect(store.current()?.nodes[0]?.id).toBe("api");
  expect(store.revision).toBe(1);
  store.close();
});

test("invalid file keeps last good revision and emits architecture.error", async () => {
  const dir = tmpRepo();
  const store = createArchitectureStore(join(dir, "architecture.json"), { watch: false });
  await store.load();
  const errors: string[] = [];
  store.onError((e) => errors.push(e.message));
  writeFileSync(join(dir, "architecture.json"), "{ not json");
  await store.load();
  expect(errors).toHaveLength(1);
  expect(store.current()?.name).toBe("acme-platform");
  expect(store.revision).toBe(1);
  store.close();
});

test("watch picks up a change: invalid write then valid write", async () => {
  const dir = tmpRepo();
  const store = createArchitectureStore(join(dir, "architecture.json"), { watch: true });
  await store.load();
  const events: { reason: string; revision: number }[] = [];
  store.onChange((e) => events.push({ reason: e.reason, revision: e.revision }));
  writeFileSync(join(dir, "architecture.json"), "{ broken");
  await new Promise((r) => setTimeout(r, 400));
  expect(store.revision).toBe(1); // invalid ignored, last good kept
  writeFileSync(join(dir, "architecture.json"), JSON.stringify({ ...GOOD, name: "renamed" }));
  await new Promise((r) => setTimeout(r, 500));
  expect(store.current()?.name).toBe("renamed");
  expect(store.revision).toBe(2);
  store.close();
});

test("save writes atomically and notifies with reason saved", async () => {
  const dir = tmpRepo();
  const store = createArchitectureStore(join(dir, "architecture.json"), { watch: false });
  await store.load();
  const events: { reason: string }[] = [];
  store.onChange((e) => events.push({ reason: e.reason }));
  const next: Architecture = { ...GOOD, nodes: [{ id: "db", type: "datastore", name: "postgres" }] };
  await store.save(next);
  expect(events[0]?.reason).toBe("saved");
  expect(store.current()?.nodes[0]?.id).toBe("db");
  const onDisk = JSON.parse(readFileSync(join(dir, "architecture.json"), "utf8")) as Architecture;
  expect(onDisk.nodes[0]?.id).toBe("db");
  const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp-"));
  expect(leftovers).toEqual([]);
  store.close();
});

test("save rejects an invalid architecture without writing", async () => {
  const dir = tmpRepo();
  const store = createArchitectureStore(join(dir, "architecture.json"), { watch: false });
  await store.load();
  const bad = { ...GOOD, version: 2 } as unknown as Architecture;
  await expect(store.save(bad)).rejects.toThrow();
  expect(store.current()?.name).toBe("acme-platform");
  store.close();
});

test("layout fills missing x/y on the 260x110 grid", async () => {
  const dir = tmpRepo();
  const store = createArchitectureStore(join(dir, "architecture.json"), { watch: false });
  await store.load();
  const node = store.current()?.nodes[0];
  expect(node?.x).toBe(520); // service -> column 2
  expect(node?.y).toBe(0);
  store.close();
});

test("close stops the watcher", async () => {
  const dir = tmpRepo();
  const store = createArchitectureStore(join(dir, "architecture.json"), { watch: true });
  await store.load();
  store.close();
  expect(existsSync(join(dir, "architecture.json"))).toBe(true);
});
