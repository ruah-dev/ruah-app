// Adapted from t3code apps/server/src/provider/Drivers/ClaudeSkillDispatch.ts (MIT, eff44be43) — see THIRD_PARTY_NOTICES.md
//
// src/acp/claude-skill-dispatch.ts — turns `$skill` mentions in a prompt into
// the slash invocation Claude Code actually runs.
//
// Claude Code does not parse `$name`; its only user-side invocation is a text
// block whose first character is `/`: the harness expands `/name args` into
// the SKILL.md body, and every character after the name arrives as
// ARGUMENTS. The check runs on the LAST text block of the message, and only
// one skill expands per message; earlier mentions are rewritten to `/name`
// inline so the model can still start them through its Skill tool.
//
// t3code discovers skill names by scanning the filesystem (ClaudeSkills.ts);
// archmap takes them from the SDK's initialize response (`commands`) instead,
// which already reflects user, project and plugin skills.

const SKILL_MENTION_PATTERN =
  /(^|\s)\$(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/g;

export interface ClaudeSkillDispatch {
  /** Text before the dispatched mention, or `undefined` when it opens the prompt. */
  readonly leadingText: string | undefined;
  /** `/name` plus the trailing text, ready to be the message's last text block. */
  readonly commandText: string;
  readonly skillName: string;
}

/**
 * Split `prompt` around the last `$skill` mention that names a known skill.
 * Returns `undefined` when there is nothing to dispatch. Mentions that do not
 * match a known skill stay literal: a `$HOME` in prose must not become a
 * command.
 */
export function planClaudeSkillDispatch(prompt: string, skillNames: ReadonlySet<string>): ClaudeSkillDispatch | undefined {
  const mentions = [...prompt.matchAll(SKILL_MENTION_PATTERN)].flatMap((match) => {
    const name = match[2] ?? "";
    if (!skillNames.has(name)) return [];
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    return [{ name, start, end: start + name.length + 1 }];
  });
  const last = mentions.at(-1);
  if (last === undefined) return undefined;

  const leading = prompt.slice(0, last.start);
  const trailing = prompt.slice(last.end);
  const leadingWithInlineSlashes = mentions
    .slice(0, -1)
    .reduceRight((text, mention) => `${text.slice(0, mention.start)}/${text.slice(mention.start + 1)}`, leading)
    .trimEnd();

  return {
    leadingText: leadingWithInlineSlashes.length > 0 ? leadingWithInlineSlashes : undefined,
    commandText: `/${last.name}${trailing}`.trimEnd(),
    skillName: last.name,
  };
}
