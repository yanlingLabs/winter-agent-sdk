// Phase 5 Lane S: `Settings.strictPluginOnlyCustomization` (`sdk.d.ts:5988`).
//
// `boolean | ('skills'|'agents'|'hooks'|'mcp')[]` -- when it applies to an area, ONLY plugin-sourced
// customization of that area loads; the project/user/local filesystem tiers are excluded outright.
// A one-function module because four different loaders read the same setting and must not each
// re-derive the boolean-vs-array reading (the producer drift R5-2 exists to catch).
//
// SCOPE AT P5, disclosed in the report: `"skills"` is the only area WIRED, in `SkillIndex.build`.
// The other three areas have their own loaders in this lane and in T2's, and wiring them is a
// one-line call each -- but a gate applied to agents or hooks without a fixture proving it fires is
// exactly the kind of half-landed security-shaped feature this phase's reviews look for. Named here
// so the remaining wiring is a known, small item rather than a silent absence.

// THE P5 SETTINGS KEYS THIS LANE CONSUMES ARE NOT DECLARED ON WINTER'S `Settings` (fix round 1,
// disclosure). `packages/sdk/src/settings/types.ts` declares the keys P5 RESOLVES plus an index
// signature, and these six land on that index signature as `unknown`:
//
//   skillOverrides, disableBundledSkills, strictPluginOnlyCustomization,
//   skillListingMaxDescChars, skillListingBudgetFraction, mcpServers
//
// So every one of them is PRESERVED and reaches a consumer, but arrives untyped: T8 must read and
// NARROW each itself before handing it to `SkillIndex.build` / `buildSkillListing` /
// `settingsMcpServerSources`, all of which take a typed parameter. This lane cannot declare them --
// `settings/**` is spine (R5-12) -- and none of them widens capability, so none needs
// overlay-never treatment. A T8/spine note, recorded here because this is the one file in this lane
// whose whole subject is a settings key.

/** The pinned area names. An unrecognised string in the array is ignored, never treated as `true`. */
export type StrictPluginOnlyArea = "skills" | "agents" | "hooks" | "mcp";

export type StrictPluginOnlyCustomization = boolean | readonly string[];

/**
 * Does the setting restrict `area` to plugin-sourced customization only?
 *
 * `true` restricts every area; an array restricts exactly the areas it names; `false`/absent/an
 * empty array restrict nothing. A non-array, non-boolean value (a settings file is JSON and may
 * carry anything) restricts nothing -- the fail-OPEN direction is correct here because this setting
 * REMOVES capability: reading a malformed value as "restrict everything" would silently delete a
 * user's whole skills directory from the session over a typo.
 */
export function isStrictPluginOnly(value: StrictPluginOnlyCustomization | undefined, area: StrictPluginOnlyArea): boolean {
  if (value === true) return true;
  if (Array.isArray(value)) return value.includes(area);
  return false;
}
