// Phase 4 Task 8 (rider 18): the ONE production registration of Lane C's child-engine factory.
//
// Lane C's Disclosed Gap #1, verbatim: "`createChildEngineFactory(deps)` takes [provider/store] as
// construction-time dependencies; the ONE production call,
// `registerChildEngineFactory(createChildEngineFactory({provider, store, ...}))`, must live in
// `main.ts` near where it already builds its own top-level provider/store. **`main.ts` is on this
// lane's never-modify list -- that one call was never made.** Until it lands, a real production
// session's `Agent` tool calls fail with the pre-existing, already-tested 'no child engine factory
// is registered' error rather than truly spawning a child."
//
// WHY A SHARED HELPER RATHER THAN THE ONE-LINER IN main.ts THE GAP DESCRIBES: the registry is a
// process-level module singleton, and a spawned/compiled `winter` child does NOT share module state
// with a test harness driving `runEngine` in-process. If only `main.ts` registered, the child and
// compiled transport legs would spawn real subagents while the in-memory leg answered "no child
// engine factory is registered" -- and WS-04 §12 makes a cross-leg divergence a release blocker, not
// a test nuisance. Both entrypoints (`main.ts` and `testing.ts`'s `inMemoryProcess`) therefore call
// THIS function, so all three legs derive their factory from one piece of code with one set of
// mirrors. That is also exactly what makes the cross-transport spawn-round equivalence scenario
// possible at all.
//
// EVERY `deps` field below is a CONSTRUCTION-TIME MIRROR of the parent's own configuration, which is
// the shape `ChildEngineFactoryDeps` was built for and the residual limitation its own header
// discloses: nothing reachable from an already-registered factory can see the parent's LIVE
// configuration, so a mid-run change to the parent's rules/hooks does not reach an already-spawned
// child. `getParentPolicy` is the one exception -- it is a per-spawn accessor supplied on the RUN
// context (engine.ts), read fresh at resume time, which is why WS-10 §9's stricter-of comparison is
// live even though these mirrors are not.
import type { Provider } from "../engine.ts";
import type { RuntimeConfig, SessionStore } from "@yanlinglabs/winter-agent-sdk";
import { registerChildEngineFactory } from "./child-handle.ts";
import { createChildEngineFactory } from "./child-engine.ts";
import type { SystemPromptAssembler } from "../context/seam.ts";
import type { SkillSessionRuntime } from "../skills/runtime.ts";
import type { StructuredOutputSeam } from "../structured/seam.ts";
import type { SourcedHookEntry } from "../hooks/registry.ts";
import type { CompactionController } from "../compaction/seam.ts";
import type { EngineSettingsRuleSeed } from "../engine.ts";
import type { SkillListing } from "../context/seam.ts";

export interface DefaultChildEngineFactoryOptions {
  provider: Provider;
  // The session's EFFECTIVE config (post-`resolveEngineSession`), which is what every mirror below
  // is taken from -- never the raw pre-resolution config.
  config: RuntimeConfig;
  // The resolved durable store + its own absolute root, or BOTH omitted for a non-persistent
  // session. They travel together deliberately: `winterHome` exists only so `record.transcript` can
  // be a genuine, model-readable absolute path (Lane C's own M1 fix), and a store without it
  // degrades that to a relative key.
  store?: SessionStore;
  winterHome?: string;
  env: Record<string, string | undefined>;
  // --- Phase 5 Task 8 --------------------------------------------------------------------------
  //
  // The session's own assembler and skill index, so a CHILD gets the same context surface its
  // parent does. Both are mirrors like every other field here, and both close a real gap Lane C's
  // report named: without the assembler a child's system prompt is `agentSystemPrompt` VERBATIM
  // (engine.ts's R5-16 fallback), losing the minimal prompt, the dynamic sections, WINTER.md and the
  // memory block; without the skill index every `Skill` call inside a child answers "no skills
  // runtime" (`skills/runtime.ts` is keyed `agentId ?? sessionId`, so a child never inherits its
  // parent's registration -- deliberately, since it must not inherit its parent's `skills` filter).
  systemPromptAssembler?: SystemPromptAssembler;
  skillRuntime?: { index: SkillSessionRuntime["index"]; skillOverrides?: SkillSessionRuntime["skillOverrides"] };
  // The session's own structured-output seam -- see ChildEngineFactoryDeps for why a child without
  // one fails its first round the moment `agent({schema})` sets an `outputFormat`.
  structuredOutput?: StructuredOutputSeam;
  /** Phase 5 fix wave, I4: the settings-file + plugin hook entries -- see ChildEngineFactoryDeps. */
  extraHookEntries?: readonly SourcedHookEntry[];
  /** Phase 5 fix wave, I4: a compaction controller for children -- see ChildEngineFactoryDeps. */
  compactionController?: CompactionController;
  /**
   * Phase 5 residual round: the model-facing skill LISTING.
   *
   * IT WAS DECLARED ON `ProductionWiring.childFactoryOptions` AND NEVER FORWARDED. Both entrypoints
   * spread that object into this function, and a spread of an undeclared property is not an excess-
   * property error -- so the value arrived on `opts`, type-checked, and was dropped one line before
   * `deps`. The fix that "threaded a child's skill menu" was inert in production for exactly as long
   * as nothing asserted it end to end. Same shape as NEW-4 below, found while fixing it.
   */
  skillListing?: SkillListing;
  /**
   * Phase 5 residual round, NEW-4: the settings seed, tags intact -- see `ChildEngineFactoryDeps`
   * for why the `getParentRules` mirror is the wrong vehicle for it.
   */
  settingsRules?: EngineSettingsRuleSeed;
}

// WHOLE-BRANCH M3(d) -- THE ONE-LIVE-SESSION-PER-PROCESS ASSUMPTION, stated plainly because this
// function is where it becomes observable. `registerChildEngineFactory` sets a MODULE SINGLETON, and
// both entrypoints call this once per session start -- so two CONCURRENT in-memory sessions in one
// host process (only `inMemoryProcess` can produce that; a spawned/compiled leg is one session per
// process by construction) leave the LAST registration standing, and the earlier session's children
// would be built from the later session's provider and config mirrors. Every mirror below is
// session-scoped data, so this is a real cross-session leak, not merely a lifecycle wrinkle.
//
// It is an ACCEPTED assumption at this phase, the same one tools/background-tasks.ts and
// subagents/limits.ts already document for their own module-level state (P3's ONE-LIVE-ENGINE
// posture, which R4-4's in-process children stretch but do not break: a child is another engine in
// the same SESSION). A daemon serving genuinely concurrent sessions in one process is WS-15's, and
// the fix shape is the same for all three: key the state by session id instead of by module.
export function registerDefaultChildEngineFactory(opts: DefaultChildEngineFactoryOptions): void {
  const { config } = opts;
  registerChildEngineFactory(
    createChildEngineFactory({
      provider: opts.provider,
      env: opts.env,
      ...(opts.store !== undefined ? { store: opts.store } : {}),
      ...(opts.winterHome !== undefined ? { winterHome: opts.winterHome } : {}),
      // WS-07 §6.4: a managed veto on bypass must bind on every descendant, not just this session.
      //
      // NEW-4 (residual round): `|| settingsRules?.disableBypassPermissionsMode`. The veto is
      // restrictive, so `true` from ANY tier wins and no trust question arises -- exactly the rule
      // `engine.ts` already applies for the parent (`config.permissions?... === true ||
      // settingsRules?... === true`). Reading `config.permissions` alone here was the third instance
      // of NEW-4's class: a managed-tier veto governed the session and was silent for every child,
      // which is the one direction a veto must never fail in.
      ...(config.permissions?.disableBypassPermissionsMode === true || opts.settingsRules?.disableBypassPermissionsMode === true
        ? { disableBypassPermissionsMode: true }
        : config.permissions?.disableBypassPermissionsMode !== undefined
          ? { disableBypassPermissionsMode: config.permissions.disableBypassPermissionsMode }
          : {}),
      // WS-10 §4: applies uniformly at every nesting level -- the ORIGINAL top-level value is not
      // reachable through the per-run seam once a grandchild spawns its own child.
      forwardSubagentText: config.forwardSubagentText === true,
      // Lane C's I1 fix: without these, a forced-bypass child (WS-07 §11 forces bypass onto every
      // descendant of a bypass parent) would auto-approve exactly what the parent's own configured
      // deny/ask rules forbid. The hardcoded BASELINE_DENY_RULES floor always bound; only the
      // SESSION's own rules were missing.
      ...(config.permissions?.allow !== undefined || config.permissions?.ask !== undefined || config.permissions?.deny !== undefined
        ? {
            parentPermissionRules: {
              ...(config.permissions.allow !== undefined ? { allow: config.permissions.allow } : {}),
              ...(config.permissions.ask !== undefined ? { ask: config.permissions.ask } : {}),
              ...(config.permissions.deny !== undefined ? { deny: config.permissions.deny } : {}),
            },
          }
        : {}),
      ...(config.hooks !== undefined ? { parentHooks: config.hooks } : {}),
      ...(config.includeHookEvents !== undefined ? { parentIncludeHookEvents: config.includeHookEvents } : {}),
      ...(config.sandbox !== undefined ? { parentSandbox: config.sandbox } : {}),
      // Phase 5 Task 8: see this interface's own fields for why each is a real gap.
      ...(opts.systemPromptAssembler !== undefined ? { systemPromptAssembler: opts.systemPromptAssembler } : {}),
      ...(opts.skillRuntime !== undefined ? { skillRuntime: opts.skillRuntime } : {}),
      ...(opts.structuredOutput !== undefined ? { structuredOutput: opts.structuredOutput } : {}),
      ...(opts.extraHookEntries !== undefined ? { extraHookEntries: opts.extraHookEntries } : {}),
      ...(opts.compactionController !== undefined ? { compactionController: opts.compactionController } : {}),
      // Residual round: the two that were declared upstream and never arrived (see this interface).
      ...(opts.skillListing !== undefined ? { skillListing: opts.skillListing } : {}),
      ...(opts.settingsRules !== undefined ? { settingsRules: opts.settingsRules } : {}),
    }),
  );
}
