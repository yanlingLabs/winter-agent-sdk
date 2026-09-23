// WS-21 §3.4.4 step 4 / §6.3 item 6 (F17, F20): claude's own settings `env` per-tier filters, plus
// the router-only variables (Global Constraints: `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_PLUGIN_CACHE_DIR`,
// `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`, `CLAUDE_CODE_DISABLE_CRON`, `WINTER_HOME`,
// `WINTER_STORE_HOME`, `WINTER_PLUGIN_CACHE_DIR`, `WINTER_PROVIDER_MANAGED_BY_HOST`,
// `WINTER_DISABLE_CRON`), refused from every settings tier so a `settings.json` `env` block can
// never forge what only the router may set.
//
// WHY THIS FILE, AND WHY IT NEVER SPELLS A `WINTER_*` NAME AS A LITERAL: `brand-gate.test.ts`'s rule
// 10 matches a product env name spelled literally anywhere in this package -- deliberately, since a
// hardcoded `"WINTER_HOME"` here would be the one settings-env filter a reuser's own brand could
// never take effect in. Every Winter-brand name below comes from `envName`/`storeHomeEnvName`/
// `pluginCacheDirEnvName`/`providerManagedByHostEnvName`/`disableCronEnvName`, called on
// `WINTER_BRAND` (the module-scope default every other constant in this codebase derives its own
// name from -- `WINTER_MD_BASENAME`, `WINTER_BRAND.instructionsFile`, is the identical pattern).
//
// TWO SEPARATE FACTS, deliberately two lists: `ALL_TIER_REFUSED_ENV` (nothing may EVER set these --
// they are either router-owned or, per F17, dropped from every tier regardless) and
// `PROJECT_TIER_REFUSED_ENV` (project/local specifically, because a checked-in `settings.json` or a
// gitignored `settings.local.json` is closer to attacker-controlled than a user's own file --
// `HOME`/`XDG_CONFIG_HOME` retargeting the whole process's config root is exactly that class of
// self-grant). `HOST_MANAGED_REFUSED_ENV_PATTERNS` is the THIRD, orthogonal fact (F20): once
// `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`/`WINTER_PROVIDER_MANAGED_BY_HOST` is set (by the router, in
// the process env -- settings can never set it, which is exactly why it lives in the refused-name
// lists above too), every tier's `env` additionally loses every provider/auth/proxy/TLS key, so a
// settings file cannot override the host-managed provider identity.
import { disableCronEnvName, envName, pluginCacheDirEnvName, providerManagedByHostEnvName, storeHomeEnvName, WINTER_BRAND } from "@yanlinglabs/winter-agent-sdk";

export type EnvFilterTier = "user" | "project" | "local" | "flag";

/**
 * F17 (V8): what a PROJECT or LOCAL tier's `env` block may never set, on top of
 * `ALL_TIER_REFUSED_ENV`. `CLAUDE_CODE_PLUGIN_SEED_DIR`/`CLAUDE_CODE_PROCESS_WRAPPER` are claude's
 * own names (no Winter twin exists); `pluginCacheDirEnvName` is `CLAUDE_CODE_PLUGIN_CACHE_DIR`'s
 * twin, refused at this tier for the identical reason claude refuses the original.
 */
export const PROJECT_TIER_REFUSED_ENV: readonly string[] = [
  "HOME",
  "XDG_CONFIG_HOME",
  "ANTHROPIC_CONFIG_DIR",
  "CLAUDE_CODE_PLUGIN_CACHE_DIR",
  "CLAUDE_CODE_PLUGIN_SEED_DIR",
  "CLAUDE_CODE_PROCESS_WRAPPER",
  pluginCacheDirEnvName(WINTER_BRAND),
];

/**
 * F17's "every tier drops" list, plus every variable ONLY the router may set (spec §3.4.4 step 4 /
 * the Global Constraints list) -- claude-named and Winter-brand-twinned alike. `CLAUDE_CONFIG_DIR`
 * is explicitly HERE despite F17 saying claude itself never drops it (F17 describes claude's OWN
 * base rule; Winter's router additionally refuses it from settings because only the router may ever
 * set the child's config dir -- the Global Constraints list is the authority for that addition).
 */
export const ALL_TIER_REFUSED_ENV: readonly string[] = [
  // F17's own "every tier drops" set:
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
  "ANTHROPIC_UNIX_SOCKET",
  "CLAUDE_CODE_PROJECT_DIR_NAME",
  // Router-only variables (spec §3.4.4 step 4 / Global Constraints), claude-named:
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_PLUGIN_CACHE_DIR",
  "CLAUDE_CODE_DISABLE_CRON",
  // ...and their Winter-brand twins:
  envName(WINTER_BRAND, "HOME"),
  storeHomeEnvName(WINTER_BRAND),
  pluginCacheDirEnvName(WINTER_BRAND),
  providerManagedByHostEnvName(WINTER_BRAND),
  disableCronEnvName(WINTER_BRAND),
];

/**
 * F20: once host-managed provider auth is on, every tier's `env` additionally loses every
 * provider/auth/proxy/TLS key -- DISCLOSED, not exhaustively pinned against a live capture (F20's
 * own wording is categorical: "provider, auth, proxy and TLS keys", not a closed name list). Grown
 * by a fixture the way V19's own repo-read enumeration is, rather than guessed complete here.
 */
export const HOST_MANAGED_REFUSED_ENV_PATTERNS: readonly RegExp[] = [
  /^ANTHROPIC_/, // provider identity + endpoint (ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ...)
  /^AWS_/, // bedrock credentials
  /^(GOOGLE|GCLOUD|GCP)_/, // vertex/gcp credentials
  /_API_KEY$/,
  /_AUTH_TOKEN$/,
  /^(HTTPS?_PROXY|ALL_PROXY|NO_PROXY|https?_proxy|all_proxy|no_proxy)$/, // proxy
  /^(NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/, // TLS
  /_CA_(CERT|BUNDLE)$/,
];

/**
 * `Settings` KEYS (not env vars) that host-managed mode disables (F20: "disables apiKeyHelper/
 * awsAuthRefresh/awsCredentialExport"). Only `apiKeyHelper` is modelled in Winter's own `Settings`
 * shape today (`packages/sdk/src/settings/types.ts:95`) -- claude's `awsAuthRefresh`/
 * `awsCredentialExport` have no Winter field to disable yet, so there is nothing to add for them
 * until one exists.
 */
export const HOST_MANAGED_DISABLED_SETTINGS_KEYS: readonly string[] = ["apiKeyHelper"];

/**
 * Filters one settings tier's `env` block before it reaches the child's process env. `undefined`
 * input (no `env` block at all) yields `{}`, never a throw.
 */
export function filterSettingsEnv(env: Record<string, string> | undefined, tier: EnvFilterTier, opts: { hostManaged: boolean }): Record<string, string> {
  if (env === undefined) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (ALL_TIER_REFUSED_ENV.includes(key)) continue;
    if ((tier === "project" || tier === "local") && PROJECT_TIER_REFUSED_ENV.includes(key)) continue;
    if (opts.hostManaged && HOST_MANAGED_REFUSED_ENV_PATTERNS.some((re) => re.test(key))) continue;
    out[key] = value;
  }
  return out;
}

/**
 * F20's settings-KEY half of host-managed mode: strips `HOST_MANAGED_DISABLED_SETTINGS_KEYS` from a
 * settings-shaped object when `hostManaged` is on. Generic over the object shape (`production-
 * wiring.ts` applies it to a tier's resolved `Settings`, never re-deriving the key list itself).
 */
export function applyHostManagedSettingsFilter(settings: Record<string, unknown>, hostManaged: boolean): Record<string, unknown> {
  if (!hostManaged) return settings;
  let changed = false;
  const out: Record<string, unknown> = { ...settings };
  for (const key of HOST_MANAGED_DISABLED_SETTINGS_KEYS) {
    if (key in out) {
      delete out[key];
      changed = true;
    }
  }
  return changed ? out : settings;
}
