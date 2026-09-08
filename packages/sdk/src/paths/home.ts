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
 * load. The brand arrives with `--config-json`, so a module-level read of a literal `<PREFIX>HOME`
 * would bake in the wrong prefix for a reuser and could never be corrected; the sweep gate
 * (packages/runtime/src/brand-gate.test.ts, rules 9 and 10) is what keeps it that way.
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

/**
 * P7a fix wave (item 5, whole-branch review M-3): THE OTHER HALF OF THE DEV PROFILE.
 *
 * WS-01's Phase 6 amendment pairs `<PREFIX>PROFILE=dev` with BOTH `~/<homeDirName>-dev` and a
 * `.dev`-suffixed Keychain service, and assigns the fold "to whichever phase introduces the
 * profile" -- this one. Only the home half landed: an env-selected dev session got its own home and
 * its own transcript store while reading and WRITING the dist Keychain service, which is the one
 * piece of state a developer most needs separated from the copy they actually use.
 *
 * It lives here, immediately beside `resolveWinterHome`, because the two are one rule read from two
 * fields -- putting them in different files is how they came to disagree in the first place.
 *
 * AN EXPLICIT VALUE IS NEVER REWRITTEN. `hostSetKeychainService` is true when the host passed
 * `brand.keychainService` or the deprecated `keychainService` alias: they named a service, and a
 * runtime that silently appended to it would be rewriting a host's own decision -- the same
 * precedence `resolveWinterHome` gives an explicit `<PREFIX>HOME` over the profile.
 *
 * The suffix is applied only when the result still satisfies `BrandProfile`'s own service grammar
 * (64 chars); a longer name is left alone rather than made invalid, since an invalid service reaches
 * the Keychain as a lookup that can never match.
 */
export function resolveKeychainServiceForProfile(
  brand: Pick<BrandProfile, "envPrefix" | "keychainService">,
  env: Record<string, string | undefined> | undefined,
  hostSetKeychainService: boolean,
): string {
  if (hostSetKeychainService) return brand.keychainService;
  const profile = (env ?? process.env)[envName(brand, "PROFILE")];
  if (profile === undefined || profile.trim() !== "dev") return brand.keychainService;
  const suffixed = `${brand.keychainService}.dev`;
  return suffixed.length <= 64 ? suffixed : brand.keychainService;
}
