// One type scale (styles.css `@theme --text-*`): the names exist, tailwind-merge knows them (so
// `cn()` never drops a size next to a colour), and components use them instead of arbitrary pixel
// sizes. The shell's own folders are owned by another track and are not held to the last rule yet.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TYPE_SCALE, cn } from "@/lib/utils";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const css = readFileSync(join(SRC, "styles.css"), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(name)) out.push(p);
  }
  return out;
}

/** Folders another track owns this wave (see the polish report); checked once they adopt it. */
const NOT_YET = [
  "components/shell/",
  "components/launcher/",
  "components/projects/",
  "components/workspace/",
  "components/dashboard/",
  "routes/__root.tsx",
  "routes/index.tsx",
  // The wordmark is lettering, not UI text.
  "components/brand/RuahLogo.tsx",
];

describe("type scale", () => {
  it("every scale name is a --text-* token in styles.css", () => {
    for (const name of TYPE_SCALE) expect(css, name).toMatch(new RegExp(`--text-${name}:\\s*[0-9.]+px;`));
  });

  it("cn() keeps a scale size next to a colour and resolves two sizes to the last", () => {
    expect(cn("text-ui-sm", "text-muted-foreground")).toBe("text-ui-sm text-muted-foreground");
    expect(cn("text-muted-foreground", "text-title")).toBe("text-muted-foreground text-title");
    expect(cn("text-label", "text-ui")).toBe("text-ui");
    expect(cn("text-caption text-faint", "text-meta")).toBe("text-faint text-meta");
  });

  it("components use the scale, not arbitrary sizes between 10 and 22 px", () => {
    const offenders: string[] = [];
    for (const file of walk(join(SRC, "components")).concat(walk(join(SRC, "routes")))) {
      const rel = relative(SRC, file).split("\\").join("/");
      if (NOT_YET.some((p) => rel.startsWith(p))) continue;
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) {
        const px = Number(m[1]);
        if (px >= 10 && px <= 22) offenders.push(`${rel}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
