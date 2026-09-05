// Phase 5 Lane S (WS-07 §3, WS-11 §2.3): matching a `Skill(...)` permission rule against a live
// invocation.
//
// WHY THIS EXISTS RATHER THAN A grammar.ts BRANCH. `permissions/**` is frozen to this lane (R5-12),
// but the deeper reason is that grammar.ts genuinely CANNOT express this rule family today, and the
// way it fails is silent:
//
//   * `matchesRule`'s `"pattern"` case reads `call.input["command"]`. A Skill call's input is
//     `{ skill, args? }` and carries no `command` at all, so every pattern-kind Skill rule compares
//     against `""` and never matches.
//   * `parseRule`'s generic dispatch splits on `FIELD_VALUE = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/`,
//     so the SAME rule shape parses three different ways depending on the skill's name:
//       `Skill(review:*)`        -> param   { field: "review", value: "*" }  (allow-direction param
//                                                                            rules never match)
//       `Skill(my-skill:*)`      -> pattern (the hyphen fails the field regex)
//       `Skill(.winter:review)`  -> pattern (the leading dot fails it)
//     A user's rule would work or not work according to whether their skill's name has a hyphen.
//
// So this module takes the RAW rule content string and matches it against the invocation's own
// identities. Anchoring on the identities is what makes the name/argument split unambiguous: a
// qualified name (`acme:review`, `.winter:review`) contains a colon, and no amount of left-to-right
// parsing can tell that colon from an argument separator without knowing the real names. Matching
// the LONGEST identity first means `.winter:review:src` reads as name `.winter:review` + argument
// `src`, never as name `.winter` + argument `review:src`.
//
// T8 OWES THE ROUTING (NEEDS_CONTEXT in the report): the evaluator must call this for `Skill` calls
// instead of falling through to `matchesRule`. Until it does, a hand-written `Skill(...)` rule is
// inert in a live session -- the auto entries `autoSkillPermissionEntries` produces for `"all"`
// (the bare `Skill` rule) are the one form that already works, because grammar.ts treats a bare rule
// as matching regardless of input.

const SKILL_RULE_SHAPE = /^Skill(?:\((.*)\))?$/s;

/** The invocation, reduced to what a rule can see. `identities` is `SkillIndex.identities(name)`. */
export interface SkillRuleTarget {
  identities: readonly string[];
  args?: string | undefined;
}

/**
 * Parse a rule STRING into its Skill content, or `undefined` when the rule is not a Skill rule at
 * all. A bare `Skill` yields `{ content: undefined }` -- the match-everything form, matching
 * grammar.ts's own `isBareEquivalent` reading of a bare tool name.
 */
export function parseSkillRule(raw: string): { content: string | undefined } | undefined {
  const m = SKILL_RULE_SHAPE.exec(raw.trim());
  if (!m) return undefined;
  return { content: m[1] };
}

function escapeRegExpLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The argument half of a rule. `*` (alone) matches any arguments including none; a trailing `*` is a
 * PREFIX match (WS-07 §3's "argument prefix"); a `*` elsewhere is a plain wildcard; no `*` at all is
 * an exact compare. Deliberately the same three behaviours grammar.ts's own `compilePattern` gives,
 * re-derived here rather than imported -- `compilePattern` is module-private to a frozen file.
 */
function argumentMatches(pattern: string, args: string): boolean {
  if (pattern === "*") return true;
  const source = pattern.split("*").map(escapeRegExpLiteral).join(".*");
  return new RegExp(`^${source}$`, "s").test(args);
}

/**
 * Does `content` (a `Skill(...)` rule's raw inner text) match this invocation?
 *
 * `undefined` content (a bare `Skill` rule) and a literal `*` both match everything.
 */
export function matchesSkillRule(content: string | undefined, target: SkillRuleTarget): boolean {
  if (content === undefined || content === "*") return true;
  const args = target.args ?? "";
  // Longest identity first, so a qualified name is never mistaken for name + argument.
  const identities = [...target.identities].sort((a, b) => b.length - a.length);
  for (const identity of identities) {
    if (content === identity) return true; // name only -- any arguments
    if (content.startsWith(`${identity}:`)) {
      return argumentMatches(content.slice(identity.length + 1), args);
    }
  }
  return false;
}

/** True when ANY rule in the list is a Skill rule matching this invocation. Non-Skill rules are ignored. */
export function skillRulesAllow(rules: readonly string[] | undefined, target: SkillRuleTarget): boolean {
  if (!rules) return false;
  for (const raw of rules) {
    const parsed = parseSkillRule(raw);
    if (parsed && matchesSkillRule(parsed.content, target)) return true;
  }
  return false;
}
