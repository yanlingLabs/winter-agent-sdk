// Phase 5 Lane S: the HOOK BLOCK producers -- settings tiers and plugin manifests.
//
// Both feed `buildHookEntriesFromSettings` (hooks/from-config.ts), which is the ONE parser for the
// `{ <Event>: [{matcher?, hooks: [{type:"command", command, timeout?}]}] }` shape. Nothing here
// re-parses it, and nothing here filters by trust: `buildHookRegistry(entries, {trustedWorkspace})`
// excludes project/local wholesale, and from-config.ts's own header instructs a P5 loader not to
// re-implement that. A CALLER MUST route these entries through `buildHookRegistry`, never straight
// into a runner (T2 divergence 8).
//
// A `{type:"command"}` entry now has a real executor: `createCommandHookInvoker`
// (hooks/command-invoker.ts), which dispatches BY ENTRY ID. That fact is what makes the plugin id
// scheme below load-bearing rather than cosmetic -- see PLUGIN_HOOK_SOURCE.
import { buildHookEntriesFromSettings, type HookEntriesFromSettings, type SettingsHookSourceInput } from "../../hooks/from-config.ts";
import type { SourcedHookEntry } from "../../hooks/registry.ts";
import type { PluginBundle } from "../../plugins/bundle.ts";

/**
 * The `HookSource` a plugin's hooks are filed under.
 *
 * WAS `sdk`, A DISCLOSED STAND-IN -- Phase 5 Task 8 (rider 19) added the real `plugin` member to
 * `HookSource`, closing this lane's own NEEDS_CONTEXT 4. The stand-in's visible cost was that a
 * plugin hook was indistinguishable from an `Options.hooks` registration in an audit record's
 * `source` field; it now names itself.
 *
 * UNGATED by workspace trust, unchanged: a plugin is loaded because a decision was made outside the
 * repository, so gating it on which directory the session is in is neither the pin's model nor
 * Winter's (`subagents/definitions.ts` records the identical reasoning for `pluginAgents`). It ranks
 * LAST in the merge order (`SOURCE_RANK.plugin = 5`, after `sdk`) -- a plugin ships defaults every
 * more-specific source may override.
 */
export const PLUGIN_HOOK_SOURCE = "plugin" as const;

/** The `resolveSettingsDetailed` / pinned `ResolvedSettings` shapes this accepts -- either field. */
export interface ResolvedSettingsHookInput {
  perSource?: readonly SettingsHookSourceInput[] | undefined;
  sources?: readonly SettingsHookSourceInput[] | undefined;
}

/**
 * Project a settings resolution onto `buildHookEntriesFromSettings`' input.
 *
 * `perSource` is preferred (it is a superset carrying `loaded`/`error`); the pinned `sources` array
 * is the fallback so a caller holding only a `ResolvedSettings` can still produce hooks. Both are
 * already highest-precedence-first, and this preserves that order -- the registry's own stable sort
 * uses registration order as its within-source tiebreak.
 */
export function settingsHookSourceInputs(resolved: ResolvedSettingsHookInput | undefined): SettingsHookSourceInput[] {
  const tiers = resolved?.perSource ?? resolved?.sources ?? [];
  return tiers.map((tier) => ({ ...tier }));
}

/**
 * Turn every loaded plugin's manifest `hooks` block into real entries.
 *
 * ONE `buildHookEntriesFromSettings` CALL PER PLUGIN, then the ids are re-stamped with the plugin's
 * name. That is not tidiness -- it is a correctness requirement. That function derives an id
 * positionally, `${event}:${source}:${groupIndex}:${hookIndex}`, which is deterministic on both
 * sides of the wire and therefore IDENTICAL for two different plugins whose blocks have the same
 * shape. `createCommandHookInvoker` builds `commandsById` as a `Map`, so two colliding ids would
 * leave the LAST plugin's command answering for both entries -- one plugin's hook silently running
 * another plugin's shell command. Prefixing with the plugin name also keeps a plugin id disjoint
 * from every `Options.hooks` id, which shares the same `sdk` source.
 */
export function pluginHookEntries(bundles: readonly PluginBundle[]): HookEntriesFromSettings {
  const entries: SourcedHookEntry[] = [];
  const rejected: HookEntriesFromSettings["rejected"] = [];
  for (const bundle of bundles) {
    if (bundle.hooks === undefined) continue;
    const built = buildHookEntriesFromSettings([
      {
        // `flag` is the ResolvedSettingSource that from-config.ts maps to the `sdk` HookSource --
        // and `ResolvedSettingSource` is PINNED (`sdk.d.ts:2783`, `SettingSource | 'managed' |
        // 'flag'`), so `plugin` may not be added there. The parse runs under `flag`; the entry's
        // own `source` is re-stamped to `PLUGIN_HOOK_SOURCE` below, alongside the id.
        source: "flag",
        path: bundle.manifestPath ?? bundle.path,
        settings: { hooks: bundle.hooks },
      },
    ]);
    for (const entry of built.entries) entries.push({ ...entry, source: PLUGIN_HOOK_SOURCE, id: `plugin:${bundle.name}:${entry.id}` });
    rejected.push(...built.rejected);
  }
  return { entries, rejected };
}
