import { homedir } from "node:os";
import { join } from "node:path";

// Shared "blank env value = unset" rule: both WINTER_HOME here and WINTER_TMPDIR (temp.ts) treat
// a missing key, an empty string, or a whitespace-only string identically as "not provided" —
// callers get the default rather than an accidental empty/garbage path.
export function isUnset(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

// WINTER_HOME || ~/.winter (mirrors CLAUDE_CONFIG_DIR's env-override semantics, WS-05 §4). `env`
// is injectable so tests never read the real process environment; defaults to `process.env` in
// production.
export function resolveWinterHome(env?: Record<string, string | undefined>): string {
  const override = (env ?? process.env).WINTER_HOME;
  return isUnset(override) ? join(homedir(), ".winter") : (override as string);
}
