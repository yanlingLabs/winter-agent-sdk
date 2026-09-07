import { homedir } from "node:os";
import { join } from "node:path";
import { WINTER_BRAND, envName, type BrandProfile } from "../brand.ts";

// Shared "blank env value = unset" rule: both the home override here and the temp-dir override
// (runtime's temp.ts) treat a missing key, an empty string, or a whitespace-only string identically
// as "not provided" — callers get the default rather than an accidental empty/garbage path.
export function isUnset(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

/**
 * The two brand fields this module needs. A `Pick` rather than the whole profile so a caller
 * holding a partially-threaded config (or a test) can call it without constructing one.
 */
export type HomeBrand = Pick<BrandProfile, "envPrefix" | "homeDirName">;

/**
 * `<PREFIX>HOME` || `~/<homeDirName>` — mirrors `CLAUDE_CONFIG_DIR`'s env-override semantics
 * (WS-05 §4), with the brand's own token instead of Claude's.
 *
 * `env` is injectable so tests never read the real process environment; it defaults to
 * `process.env` in production. `brand` defaults to `WINTER_BRAND`, so every existing caller keeps
 * exactly today's behaviour (`WINTER_HOME` || `~/.winter`) until it threads a profile through.
 *
 * THE ENV NAME IS DERIVED, NEVER SPELLED, and it is read INSIDE this function — never at module
 * load. The brand arrives with `--config-json`, so a module-level `process.env.WINTER_HOME` would
 * bake in the wrong prefix for a reuser and could never be corrected; the sweep gate
 * (packages/runtime/src/brand-gate.test.ts, rule 9) is what keeps it that way.
 *
 * PRECEDENCE (WS-01 §2.2, and the same rule the current daemon has always had): an explicit
 * `<PREFIX>HOME` wins over EVERYTHING, including the dev profile. `<PREFIX>PROFILE=dev` selects
 * `~/<homeDirName>-dev` — the dev/dist split, so a development build can never share a home (or a
 * transcript store, or a settings file) with the copy a user actually runs.
 */
export function resolveWinterHome(env?: Record<string, string | undefined>, brand?: HomeBrand): string {
  const b = brand ?? WINTER_BRAND;
  const e = env ?? process.env;
  const override = e[envName(b, "HOME")];
  if (!isUnset(override)) return override as string;
  const profile = e[envName(b, "PROFILE")];
  // Exactly one profile has a home of its own. Anything else (including an unrecognised value) is
  // the default home rather than a silently-invented `~/<dir>-<whatever>` directory.
  const dirName = profile !== undefined && profile.trim() === "dev" ? `${b.homeDirName}-dev` : b.homeDirName;
  return join(homedir(), dirName);
}
