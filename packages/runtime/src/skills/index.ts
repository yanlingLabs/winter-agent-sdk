// Phase 5 Lane S: the skills barrel -- the surface T8 wires and the only import path a consumer
// outside this directory should need. Side-effect free (the Skill EXECUTOR is `tools/impl/skill.ts`
// and registers itself; it is deliberately NOT re-exported here, so importing this barrel never
// mutates the tool registry).
export { DEFAULT_SKILL_BODY_BYTES, DEFAULT_SKILL_DESCRIPTION_BYTES, SKILL_NAME_PATTERN, SKILL_TRUNCATION_MARKER, capBytes, parseSkillFile, pluginNameError, skillNameError } from "./frontmatter.ts";
export type { ParsedSkillFile } from "./frontmatter.ts";

export { SELF_SUBDIR, SKILL_METADATA_PREFIX_BYTES, ABSENT_SKILL_FILE, findRepoRoot, projectSkillRoots, readSkillMetadata, scanSkillRoot, scanUserSkillRoot } from "./loader.ts";
export type { DiscoveredSkill, SkillMetadataRead, SkillScanError, SkillScanResult, SkillTier } from "./loader.ts";

export { PROJECT_PLUGIN_NAME, SkillIndex } from "./store.ts";
export type { PluginSkillContribution, SkillIndexOptions, SkillMeta } from "./store.ts";

export {
  DEFAULT_SKILL_LISTING_BUDGET_FRACTION,
  DEFAULT_SKILL_LISTING_MAX_DESC_CHARS,
  LISTING_TRUNCATION_SUFFIX,
  SKILL_LISTING_CHARS_PER_TOKEN,
  buildSkillListing,
  isModelVisible,
  isUserInvocable,
  skillListingBudgetChars,
} from "./listing.ts";
export type { BuildSkillListingOptions, SkillOverride, SkillOverrides } from "./listing.ts";

export { SKILL_TOOL_NAME, autoSkillPermissionEntries, isLegalSkillIdentity, isSkillEnabled, validateSkillsOption } from "./option.ts";
export type { SkillsOptionFailure, SkillsOptionSuccess, SkillsOptionValidation, ValidateSkillsOptions } from "./option.ts";

export { matchesSkillRule, parseSkillRule, skillRulesAllow } from "./permission-rules.ts";
export type { SkillRuleTarget } from "./permission-rules.ts";

export { INVOKED_SKILLS_ATTACHMENT_TYPE, invokedSkillsAttachment } from "./attachment.ts";
export type { InvokedSkillEntry, InvokedSkillsAttachment } from "./attachment.ts";

export { clearSkillSessionRuntime, getSkillSessionRuntime, registerSkillSessionRuntime } from "./runtime.ts";
export type { SkillSessionRuntime } from "./runtime.ts";
