// Phase 5 Task 2 -- THE SEAM AUTHORITY IMPORT SITE for settings resolution.
//
// Lanes W/S/C/K import settings resolution from HERE (`../settings/resolve.ts`), never by reaching
// into the sdk package's own module layout. The implementation itself lives in
// `packages/sdk/src/settings/*` because `resolveSettings`/`filterEscalatingDefaultMode` turned out
// to be PINNED PUBLIC SDK EXPORTS (Task 1 item (a)) and WS-02 §3 forbids the sdk package from
// importing the runtime -- the same pass-through shape `paths`/`store` already use in
// packages/runtime/src/index.ts.
export {
  resolveSettings,
  resolveSettingsDetailed,
  filterEscalatingDefaultMode,
  applyWorkspaceTrust,
  settingsPathFor,
  loadSettingsFile,
  SETTING_SOURCES,
  OVERLAY_NEVER_KEYS,
  ESCALATING_PERMISSION_MODES,
  PROJECT_PERMISSIVE_KEYS,
} from "@yanlinglabs/winter-agent-sdk";
export type {
  SettingSource,
  ResolvedSettingSource,
  PolicySettingsOrigin,
  Settings,
  SettingsPermissionsBlock,
  SettingsHooksConfig,
  SettingsHookMatcherGroup,
  SettingsHookHandler,
  ProvenanceEntry,
  ResolvedSettings,
  ResolvedSettingsSourceEntry,
  ResolveSettingsOptions,
  DetailedResolvedSettings,
  DetailedSettingsSourceEntry,
  ResolveSettingsDetailedOptions,
  WorkspaceTrustFilterOptions,
} from "@yanlinglabs/winter-agent-sdk";
