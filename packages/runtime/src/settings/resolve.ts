// Phase 5 Task 2 -- THE SEAM AUTHORITY IMPORT SITE for settings resolution.
//
// Lanes W/S/C/K import settings resolution from HERE (`../settings/resolve.ts`), never by reaching
// into the sdk package's own module layout. The implementation itself lives in
// `packages/sdk/src/settings/*` because `resolveSettings`/`filterEscalatingDefaultMode` turned out
// to be PINNED PUBLIC SDK EXPORTS (Task 1 item (a)) and WS-02 §3 forbids the sdk package from
// importing the runtime. Resolution stays in SDK; this seam supplies the runtime guarded
// source reader through a trusted callback, separate from serializable settings/options.
export {
  filterEscalatingDefaultMode,
  applyWorkspaceTrust,
  settingsPathFor,
  SETTING_SOURCES,
  OVERLAY_NEVER_KEYS,
  ESCALATING_PERMISSION_MODES,
  PROJECT_PERMISSIVE_KEYS,
  // WS-13b R6b-7: lanes import the seam from HERE, so the narrowing travels with the rest of it.
  providerSettingsFrom,
} from "@yanlinglabs/winter-agent-sdk";
import { resolveSettingsDetailed as sdkResolveSettingsDetailed, loadSettingsFile as sdkLoadSettingsFile, type ResolveSettingsDetailedOptions, type ResolveSettingsOptions } from "@yanlinglabs/winter-agent-sdk";
import { readSourceText } from "../sandbox/source-read.ts";
export const loadSettingsFile = (path: string) => sdkLoadSettingsFile(path, readSourceText);
export const resolveSettingsDetailed = (opts: ResolveSettingsDetailedOptions = {}) => sdkResolveSettingsDetailed(opts, readSourceText);
export async function resolveSettings(opts?: ResolveSettingsOptions) {
  const { effective, provenance, sources } = await resolveSettingsDetailed(opts ?? {});
  return { effective, provenance, sources };
}
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
