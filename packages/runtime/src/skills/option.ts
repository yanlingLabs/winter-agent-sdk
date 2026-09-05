// Phase 5 Lane S (WS-11 §2.2): the `skills` option -- validation and the automatic permission
// entries.
//
// "VALIDATED BEFORE SPAWNING" (report §60) IS THE WHOLE POINT of `validateSkillsOption`. A session
// configured with `skills: ["reveiw"]` must fail with a message naming the typo, not start
// successfully and then answer every invocation with "unknown skill" from inside a turn -- by which
// point a caller has already paid for a spawn and the model has already burned a tool round on it.
// So this returns a TYPED RESULT rather than throwing: T8 decides whether an unknown name aborts
// `query()` construction (the `persistSession` precedent) or degrades, and it needs the whole list
// of unknowns to say anything useful either way.
//
// TWO SEPARATE VERDICTS, deliberately not merged. Unknown NAMES make the result `ok: false`; a
// `tools` restriction that omits `"Skill"` produces a WARNING on an otherwise-successful result.
// The second is not a name error and cannot be one -- the pin marks passing `'Skill'` through
// `tools`/`allowedTools` DEPRECATED in favour of this very option (`sdk.d.ts:44`, `1438`;
// derived-shapes-p5 OQ-P5-5), so WS-11 §2.2's MUST is describing a deprecated path. Refusing to
// start a session over it would be Winter inventing a hard failure the pinned branch does not have;
// staying silent would leave a caller with a skill list that quietly does nothing. A warning is the
// only reading that is both honest and non-diverging.
import type { SkillsOption } from "@yanlinglabs/winter-agent-sdk";
import { pluginNameError, skillNameError } from "./frontmatter.ts";
import type { SkillIndex } from "./store.ts";

/** The one tool every skill is invoked through (WS-11 §2.3 -- never one tool per skill). */
export const SKILL_TOOL_NAME = "Skill";

export interface SkillsOptionSuccess {
  ok: true;
  /** The caller's names, order preserved, unresolved aliases left exactly as written. */
  skills: string[];
  warnings: string[];
}
export interface SkillsOptionFailure {
  ok: false;
  unknown: string[];
  message: string;
  warnings: string[];
}
export type SkillsOptionValidation = SkillsOptionSuccess | SkillsOptionFailure;

export interface ValidateSkillsOptions {
  /**
   * An explicit BUILT-IN RESTRICTION list -- `AgentDefinition.tools` for a child, or a host's own
   * equivalent for the main session. An EMPTY array is treated as "no restriction", matching
   * `validateAgentDefinition`'s existing reading in subagents/definitions.ts.
   */
  tools?: readonly string[] | undefined;
  /** `Options.disallowedTools` -- the other way to make the Skill tool unreachable. */
  disallowedTools?: readonly string[] | undefined;
}

function toolsRestrictSkill(opts: ValidateSkillsOptions | undefined): boolean {
  const tools = opts?.tools;
  if (tools !== undefined && tools.length > 0 && !tools.includes(SKILL_TOOL_NAME)) return true;
  return opts?.disallowedTools?.includes(SKILL_TOOL_NAME) === true;
}

/**
 * Validate the option against a built index.
 *
 * `undefined` and `"all"` both mean "every indexed skill" (capture (4): omitting the option is NOT
 * "skills off"); `[]` means "none", which is a legitimate, validated configuration and NOT the same
 * thing as omission.
 */
export function validateSkillsOption(skills: SkillsOption | undefined, index: SkillIndex, opts?: ValidateSkillsOptions): SkillsOptionValidation {
  const warnings: string[] = [];
  if (skills !== undefined && toolsRestrictSkill(opts)) {
    warnings.push(
      `the "skills" option is set but the tool restriction in effect excludes "${SKILL_TOOL_NAME}" -- every configured skill is uninvocable (WS-11 §2.2). Note that naming "${SKILL_TOOL_NAME}" in a tools/allowedTools list is deprecated on the pinned branch in favour of "skills" itself.`,
    );
  }
  if (skills === undefined || skills === "all") {
    return { ok: true, skills: index.names(), warnings };
  }
  const unknown: string[] = [];
  for (const name of skills) {
    if (index.get(name) === undefined) unknown.push(name);
  }
  if (unknown.length > 0) {
    return {
      ok: false,
      unknown,
      message: `unknown skill${unknown.length === 1 ? "" : "s"} in the "skills" option: ${unknown.map((n) => JSON.stringify(n)).join(", ")}. Known skills: ${index.names().join(", ") || "(none)"}`,
      warnings,
    };
  }
  return { ok: true, skills: skills.slice(), warnings };
}

/**
 * Is `name` invocable under this session's `skills` option?
 *
 * Alias-aware in BOTH directions: an option listing `.winter:review` enables an invocation of
 * `review`, and vice versa. Without that, the two spellings of one skill would disagree about
 * whether it is enabled, which is the drift WS-11 §4's "permission rules match identically across
 * branches" exists to prevent (permission-rules.ts carries the same obligation for rules).
 */
export function isSkillEnabled(skills: SkillsOption | undefined, name: string, index: SkillIndex): boolean {
  if (skills === undefined || skills === "all") return index.get(name) !== undefined;
  const identities = new Set(index.identities(name));
  if (identities.size === 0) return false;
  return skills.some((listed) => identities.has(listed));
}

/**
 * The permission entries the ENGINE adds when `skills` is set -- WS-11 §2.2: "callers do not add
 * them to `allowedTools`".
 *
 * Rule strings, not `PermissionRuleValue` objects, because `RuntimeConfig.allowedTools` /
 * `permissions.allow` are both `string[]` and that is where these land.
 *
 * `"all"` produces the BARE tool rule (`Skill`), which grammar.ts already treats as matching every
 * call regardless of input -- exactly the intended meaning, and it stays one entry however many
 * skills are installed. A list produces one name-scoped rule each; matching those against a live
 * invocation is permission-rules.ts's job (grammar.ts cannot do it today -- see that file's header).
 */
export function autoSkillPermissionEntries(skills: SkillsOption | undefined): string[] {
  if (skills === undefined) return [];
  if (skills === "all") return [SKILL_TOOL_NAME];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of skills) {
    const rule = `${SKILL_TOOL_NAME}(${name})`;
    if (seen.has(rule)) continue;
    seen.add(rule);
    out.push(rule);
  }
  return out;
}

/**
 * A name is rejected before it ever reaches the filesystem if it is not a legal identity: a bare
 * slug, or `<plugin>:<slug>`. Used by the executor, which receives its name from the MODEL and must
 * not hand an arbitrary string to a path join.
 *
 * The plugin half uses `pluginNameError`, THE SAME JAIL `SkillIndex.build` admits plugin names by --
 * not a stricter one. Two jails that disagree produce a skill the index advertises and the executor
 * refuses: `PLUGIN_NAME_PATTERN` admits any leading-dot name, so a plugin named `.acme` indexes
 * `.acme:ship`, and a check that special-cased only `.winter` would reject it at invocation.
 */
export function isLegalSkillIdentity(name: string): boolean {
  const colon = name.indexOf(":");
  if (colon === -1) return skillNameError(name) === null;
  return pluginNameError(name.slice(0, colon)) === null && skillNameError(name.slice(colon + 1)) === null;
}
