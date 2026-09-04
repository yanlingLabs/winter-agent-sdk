// Phase 5 Task 2 -- per-tier settings FILE location + loading, at the path the Task 2 brief names.
//
// Pass-through only: the implementation lives in `packages/sdk/src/settings/sources.ts` because the
// settings surface turned out to be a PINNED PUBLIC SDK export and WS-02 §3 forbids the sdk package
// from importing the runtime (see ./resolve.ts's own header for the full rationale). A lane citing
// `settings/sources.ts` from its brief lands here and gets the right symbols.
export { settingsPathFor, loadSettingsFile, SETTING_SOURCES } from "@yanlinglabs/winter-agent-sdk";
export type { SettingSource, SettingsPathOptions, LoadedSettingsFile, Settings } from "@yanlinglabs/winter-agent-sdk";
