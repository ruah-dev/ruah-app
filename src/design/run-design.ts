// src/design/run-design.ts — `ruah app design <cmd>`: the app's design tokens without the app or
// the daemon. The token library lives with the viewer (ui/src/design/tokens.ts); this is its CLI.
//   palettes                         the palettes and themes, with their role colours
//   tokens [--palette p] [--theme t] [--json]
//                                    every resolved CSS token for one palette × theme
//   check [--palette p] [--theme t] [--json] [--all]
//                                    WCAG contrast of every token pair (text 4.5:1, 7:1 in the
//                                    contrast theme; UI 3:1); exit 1 when one fails
//   css [--out <file>] [--check <file>]
//                                    the generated stylesheet (ui/src/design/tokens.css)
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  CONTRAST_PAIRS,
  PALETTES,
  PALETTE_IDS,
  THEMES,
  THEME_IDS,
  checkContrast,
  paletteSwatches,
  resolveTokens,
  type ContrastResult,
  type PaletteId,
  type ThemeId,
} from "../../ui/src/design/tokens.js";
import { renderTokensCss } from "../../ui/src/design/css.js";

export interface DesignIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

const defaultIo: DesignIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

export const DESIGN_USAGE = `ruah app design — the app's design tokens (Ruah Design System → CSS tokens), no daemon needed

  ruah app design palettes                      palettes and themes with their role colours
  ruah app design tokens [--palette <p>] [--theme <t>] [--json]
                                                every resolved token (default teal × dark)
  ruah app design check [--palette <p>] [--theme <t>] [--json] [--all]
                                                WCAG contrast of every token pair (text 4.5:1,
                                                7:1 in contrast; UI 3:1); exit 1 on a failure
  ruah app design css [--out <file>] [--check <file>]
                                                the generated stylesheet; --check exits 1 when
                                                <file> differs (stale)

  <p>: ${PALETTE_IDS.join(" | ")}   <t>: ${THEME_IDS.join(" | ")}
`;

function pick<T extends string>(value: string | undefined, allowed: readonly T[], what: string): T[] {
  if (value === undefined) return [...allowed];
  if (!allowed.includes(value as T)) throw new Error(`unknown ${what} "${value}" (${allowed.join(", ")})`);
  return [value as T];
}

function formatCheck(results: readonly ContrastResult[], all: boolean): string {
  const lines: string[] = [];
  const combos = new Map<string, ContrastResult[]>();
  for (const r of results) {
    const key = `${r.palette} × ${r.theme}`;
    combos.set(key, [...(combos.get(key) ?? []), r]);
  }
  for (const [key, rows] of combos) {
    const failed = rows.filter((r) => !r.pass);
    const worst = rows.reduce((w, r) => (r.ratio / r.min < w.ratio / w.min ? r : w));
    lines.push(
      `${failed.length ? "FAIL" : "ok  "} ${key.padEnd(22)} ${rows.length} pairs, ${failed.length} below minimum; tightest ${worst.fg} on ${worst.tint !== undefined ? `${worst.fg}/${Math.round(worst.tint * 100)}% over ` : ""}${worst.bg} ${worst.ratio.toFixed(2)}:1 (min ${worst.min})`,
    );
    for (const r of all ? rows : failed) {
      const bg = r.tint !== undefined ? `${r.fg}/${Math.round(r.tint * 100)}% over ${r.bg}` : r.bg;
      lines.push(`       ${r.pass ? " " : "x"} ${`${r.fg} on ${bg}`.padEnd(52)} ${r.ratio.toFixed(2).padStart(6)}:1  min ${r.min} (${r.kind})`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function runDesign(argv: readonly string[], io: DesignIo = defaultIo): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "palettes": {
        const lines: string[] = ["Palettes"];
        for (const id of PALETTE_IDS) {
          const p = PALETTES[id];
          const sw = paletteSwatches(id);
          lines.push(
            `  ${id.padEnd(8)} ${p.label.padEnd(15)} ${p.description}`,
            `           brand ${sw.brand}  ai ${sw.ai}  ok ${sw.ok}  warn ${sw.warn}  bad ${sw.bad}  info ${sw.info}`,
          );
        }
        lines.push("", "Themes");
        for (const id of THEME_IDS) lines.push(`  ${id.padEnd(8)} ${THEMES[id].label} (${THEMES[id].scheme}, text ${THEMES[id].textRatio}:1)`);
        io.out(`${lines.join("\n")}\n`);
        return 0;
      }
      case "tokens": {
        const { values } = parseArgs({
          args: [...rest],
          options: { palette: { type: "string" }, theme: { type: "string" }, json: { type: "boolean", default: false } },
        });
        const [palette] = pick<PaletteId>(values.palette ?? "teal", PALETTE_IDS, "palette");
        const [theme] = pick<ThemeId>(values.theme ?? "dark", THEME_IDS, "theme");
        const tokens = resolveTokens(palette!, theme!);
        if (values.json) io.out(`${JSON.stringify({ palette, theme, tokens }, null, 2)}\n`);
        else io.out(Object.entries(tokens).map(([k, v]) => `--${k}: ${v};`).join("\n") + "\n");
        return 0;
      }
      case "check": {
        const { values } = parseArgs({
          args: [...rest],
          options: {
            palette: { type: "string" },
            theme: { type: "string" },
            json: { type: "boolean", default: false },
            all: { type: "boolean", default: false },
          },
        });
        const results = checkContrast(pick(values.palette, PALETTE_IDS, "palette"), pick(values.theme, THEME_IDS, "theme"));
        const failed = results.filter((r) => !r.pass);
        if (values.json) {
          io.out(`${JSON.stringify({ pairs: CONTRAST_PAIRS.length, checked: results.length, failed: failed.length, results: values.all ? results : failed }, null, 2)}\n`);
        } else {
          io.out(formatCheck(results, values.all));
          io.out(failed.length ? `${failed.length} of ${results.length} pairs fail.\n` : `All ${results.length} pairs pass.\n`);
        }
        return failed.length ? 1 : 0;
      }
      case "css": {
        const { values } = parseArgs({
          args: [...rest],
          options: { out: { type: "string" }, check: { type: "string" } },
        });
        const css = renderTokensCss();
        if (values.check !== undefined) {
          let current = "";
          try {
            current = readFileSync(values.check, "utf8");
          } catch {
            /* missing = stale */
          }
          if (current === css) {
            io.out(`${values.check} is up to date.\n`);
            return 0;
          }
          io.err(`${values.check} is stale: run \`pnpm design:tokens\`.\n`);
          return 1;
        }
        if (values.out !== undefined) {
          writeFileSync(values.out, css);
          io.out(`wrote ${values.out}\n`);
        } else io.out(css);
        return 0;
      }
      case undefined:
      case "help":
      case "--help":
      case "-h":
        io.out(DESIGN_USAGE);
        return cmd === undefined ? 2 : 0;
      default:
        io.err(`unknown design command "${cmd}"\n\n${DESIGN_USAGE}`);
        return 2;
    }
  } catch (err) {
    io.err(`ruah app design: ${(err as Error).message}\n`);
    return 2;
  }
}
