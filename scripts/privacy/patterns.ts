// scripts/privacy/patterns.ts — what must not appear in a public repository: a machine's
// home folder, secret-shaped strings and the maintainer's private terms. Shared by
// test/repo-hygiene.test.ts (tracked files) and scripts/privacy/scan-history.ts (every
// object in the history). docs/CONTRACTS.md §22.5–§22.6.
import { readFileSync } from "node:fs";

/** Home folders that tests and docs may use as obviously fictional examples. */
export const NEUTRAL_HOMES: ReadonlySet<string> = new Set(["me", "you", "dev", "other", "someone", "user", "runner", "x"]);

/**
 * Ways a home folder or a per-user temp folder shows up in text. Each has one capture
 * group, the user name, checked against NEUTRAL_HOMES (`null` = no name: always a hit).
 */
export const HOME_SHAPES: ReadonlyArray<readonly [label: string, re: RegExp]> = [
  ["home folder (/Users/<name>, /home/<name>)", /(?:\/Users|\/home)\/([A-Za-z0-9._-]+)/g],
  // Coding-agent tools encode a working directory into a folder name:
  // ~/.claude/projects/-Users-<name>-Projects-…, /private/tmp/claude-501/-Users-<name>-…
  // (not `-home-`: kebab-case names like `nav-home-link-` would match.)
  ["home folder, dash-encoded (-Users-<name>-)", /-Users-([A-Za-z0-9._]+)-/g],
  ["home folder, Windows (C:\\Users\\<name>)", /\b[A-Za-z]:\\{1,2}Users\\{1,2}([A-Za-z0-9._-]+)/g],
  ["macOS per-user temp folder (/var/folders/…)", /\/var\/folders\/[A-Za-z0-9_+-]{2}\/[A-Za-z0-9_+-]{20,}/g],
];

/** Labels of the home-folder shapes found in `text` (one entry per match). */
export function homeFolderHits(text: string): string[] {
  const hits: string[] = [];
  for (const [label, re] of HOME_SHAPES) {
    for (const m of text.matchAll(re)) {
      const name = m[1];
      if (name === undefined || !NEUTRAL_HOMES.has(name.toLowerCase())) hits.push(label);
    }
  }
  return hits;
}

/** Token shapes of real credentials (full length, so short test placeholders do not match). */
export const SECRET_SHAPES: ReadonlyArray<readonly [label: string, re: RegExp]> = [
  ["AWS access key", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{40,}/],
  ["OpenAI key", /\bsk-(proj-)?[A-Za-z0-9_-]{40,}/],
  ["Slack token", /\bxox[abposr]-[0-9]{6,}-[A-Za-z0-9-]{10,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["DigitalOcean token", /\bdo[por]_v1_[a-f0-9]{64}\b/],
  ["Supabase token", /\bsbp_[a-f0-9]{40}\b/],
  ["Stripe live key", /\b(sk|rk)_live_[A-Za-z0-9]{20,}/],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["private key", /-----BEGIN (RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/],
];

/** Labels of the secret shapes found in `text` (once per shape). */
export function secretShapeHits(text: string): string[] {
  return SECRET_SHAPES.filter(([, re]) => re.test(text)).map(([label]) => label);
}

/** A private term and the line of the terms file it came from (reports name the line, never the term). */
export interface PrivateTerm {
  term: string;
  line: number;
}

/**
 * Terms from a file kept OUTSIDE the repository (client and project names, account and
 * resource names, a user name, a home folder): one per line, `#` starts a comment,
 * blank lines and terms shorter than 3 characters are ignored.
 */
export function parsePrivateTerms(text: string): PrivateTerm[] {
  return text
    .split("\n")
    .map((raw, i) => ({ term: raw.replace(/#.*/, "").trim(), line: i + 1 }))
    .filter((t) => t.term.length >= 3);
}

/**
 * Reads a terms file. Throws when it cannot be read or holds no usable term: a check that
 * silently matched nothing would look exactly like a clean result. The message names the
 * problem, not the path (it may sit under a home folder and end up in a CI log).
 */
export function loadPrivateTerms(file: string): PrivateTerm[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error("the private-terms file (RUAH_PRIVATE_TERMS_FILE / --terms) cannot be read");
  }
  const terms = parsePrivateTerms(text);
  if (terms.length === 0) throw new Error("the private-terms file has no term of 3 or more characters");
  return terms;
}

/** Case-insensitive matcher: the lines of the terms found in a text. */
export function privateTermMatcher(terms: readonly PrivateTerm[]): (text: string) => number[] {
  const lowered = terms.map((t) => ({ needle: t.term.toLowerCase(), line: t.line }));
  return (text) => {
    const hay = text.toLowerCase();
    return lowered.filter((t) => hay.includes(t.needle)).map((t) => t.line);
  };
}
