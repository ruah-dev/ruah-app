// Reasoning effort is saved per agent next to the model and mode (~/.ruah/settings.json
// `efforts`), and settings files without it keep their shape.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsStore } from "../src/projects/settings-store.js";

describe("saved reasoning effort", () => {
  it("round-trips per agent and clears with null", () => {
    const home = mkdtempSync(path.join(tmpdir(), "ruah-effort-"));
    const store = new SettingsStore(home, { env: {} });
    store.update({ efforts: { claude: "xhigh" } });
    expect(new SettingsStore(home, { env: {} }).get().efforts).toEqual({ claude: "xhigh" });
    store.update({ efforts: { claude: null } });
    const file = JSON.parse(readFileSync(path.join(home, "settings.json"), "utf8")) as Record<string, unknown>;
    expect(file.efforts).toBeUndefined();
  });

  it("leaves a settings file without efforts as it was", () => {
    const home = mkdtempSync(path.join(tmpdir(), "ruah-effort-"));
    writeFileSync(path.join(home, "settings.json"), JSON.stringify({ version: 1, models: { claude: "default" }, modes: {} }));
    const store = new SettingsStore(home, { env: {} });
    store.update({ models: { claude: "sonnet" } });
    const file = JSON.parse(readFileSync(path.join(home, "settings.json"), "utf8")) as Record<string, unknown>;
    expect(file).not.toHaveProperty("efforts");
    expect(file.models).toEqual({ claude: "sonnet" });
  });
});
