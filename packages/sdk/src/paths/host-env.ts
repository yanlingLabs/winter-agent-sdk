// WS-21 §3.1/§6.3 item 13, Contract B: the Winter-brand twins of the router-set host variables. Each
// one names an env var the ROUTER sets on a spawned child (never the SDK, never settings `env` --
// `settings/env-filter.ts`'s refused lists exist precisely so a settings tier cannot forge one of
// these); the child then reads its OWN env for the value, exactly as it already reads
// `envName(brand, "HOME")` (`production-wiring.ts:553`'s header, WS-21 §3.7).
//
// PARITY: `pluginCacheDirEnvName` is the direct Winter-brand twin of claude's
// `CLAUDE_CODE_PLUGIN_CACHE_DIR` (F15); `providerManagedByHostEnvName` of
// `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` (F20); `disableCronEnvName` of
// `CLAUDE_CODE_DISABLE_CRON` (F19a). `storeHomeEnvName` has no claude counterpart at all -- the
// Winter child writes its own canonical store directly (claude's wrapper only ever mirrors into
// it), so `WINTER_STORE_HOME` is host plumbing the official leg never needs (spec §3.7's own
// parity note).
import { envName, type BrandProfile } from "../brand.ts";

type EnvPrefixBrand = Pick<BrandProfile, "envPrefix">;

/** `WINTER_STORE_HOME` -- the shared runtime home's durable-paths root (spec §3.7). No claude twin. */
export function storeHomeEnvName(brand: EnvPrefixBrand): string {
  return envName(brand, "STORE_HOME");
}

/** `WINTER_PLUGIN_CACHE_DIR` -- the twin of `CLAUDE_CODE_PLUGIN_CACHE_DIR` (F15). */
export function pluginCacheDirEnvName(brand: EnvPrefixBrand): string {
  return envName(brand, "PLUGIN_CACHE_DIR");
}

/** `WINTER_PROVIDER_MANAGED_BY_HOST` -- the twin of `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` (F20). */
export function providerManagedByHostEnvName(brand: EnvPrefixBrand): string {
  return envName(brand, "PROVIDER_MANAGED_BY_HOST");
}

/** `WINTER_DISABLE_CRON` -- the twin of `CLAUDE_CODE_DISABLE_CRON` (F19a). */
export function disableCronEnvName(brand: EnvPrefixBrand): string {
  return envName(brand, "DISABLE_CRON");
}
