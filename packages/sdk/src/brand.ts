// P7a (D19, D19a; WS-01 §2 / WS-03 "Execution amendments — Phase 7a"): THE BRAND PROFILE.
//
// ONE object holds every Winter-OWNED name, and this file is the ONE place in
// packages/{sdk,runtime,provider-runtime,provider-catalog}/src and scripts/ allowed to spell those
// names as raw literals -- `packages/runtime/src/brand-gate.test.ts` is the sweep that enforces
// that, with this module as its single standing exception.
//
// WHY A PROFILE AND NOT A CONSTANT PER NAME. D19's three-tier consumption model has a host
// consuming the Winter SDK alone, the official SDK alone, or both through a router. A reuser in the
// first tier gets a real product of their own: their home dir, their env prefix, their keychain
// service, their MCP server name. Thirteen constants scattered across four packages cannot be
// swapped as a set; one validated object can, and it rides the wire (`RuntimeConfig.brand`) so a
// spawned/compiled runtime derives the SAME names the wrapper did rather than defaulting to
// Winter's behind the host's back.
//
// WHAT IS *NOT* IN HERE, deliberately:
//   - Claude-MIRRORING literals (`claude-<uid>`, `claude-resume-<uuid>`, `CLAUDE_CONFIG_DIR`,
//     `CLAUDE_CODE_TMPDIR`, `preset: "claude_code"`, the `AgentInput.model` aliases,
//     `.claude-plugin`, `com.anthropic.claude-code`). They are the official runtime's own names,
//     not ours to rebrand (WS-01 §5, D16/D19); a reuser inherits them unchanged.
//   - HARNESS/TEST env names (`WINTER_TEST_*`, `WINTER_LIVE_*`, `WINTER_COMPILED_BIN`,
//     `WINTER_CANARY_SECRET`, `WINTER_SDK_CAN_USE_TOOL_SHADOWED`, `WINTER_CREDENTIAL_MISSING`,
//     `WINTER_RUNTIME_KIND`). They are this repository's own scaffolding, never a product surface,
//     and they stay literal so a reuser's brand cannot rename this repo's test harness.
//   - Brand-neutral names: JSON-RPC methods, event/frame types, session-id shapes, `permissionMode`
//     values. Renaming those would break the drop-in contract, not personalise it.
//
// NO MODULE-LOAD ENV READ ANYWHERE. The brand arrives with `--config-json`, so any
// `process.env.<PREFIX>_X` evaluated at import time would read the WRONG (or no) prefix. Every read
// of a brand-derived env name is lazy, inside a function, and the gate's rule 9 pins that.

/**
 * Every Winter-owned name, as one swappable object.
 *
 * Field-by-field authority is WS-01 §2 (§2.1 packages/executables, §2.2 homes, §2.3 ephemeral
 * state, §2.4 project-local files, §2.5 environment variables) and §3 (product layer).
 */
export interface BrandProfile {
  /** Display name. "Winter" — user-facing prose, never a path segment. */
  productName: string;
  /**
   * The honest product token in `User-Agent` and vendor identity headers (WS-13 §5, D21).
   *
   * A reuser presents its OWN identity here: that is the whole point of the field. What it may
   * never be is somebody else's — the catalog's identity-header validator and the
   * `codexOriginator` rule below are the two enforcement points for that.
   */
  packageName: string;
  /** `~/<homeDirName>` (WS-01 §2.2). The dev profile appends `-dev`. */
  homeDirName: string;
  /** `<cwd>/<projectDirName>/` (WS-01 §2.4) — settings, agents, skills, commands, plans, rules. */
  projectDirName: string;
  /** Project + user instructions file (WS-01 §2.4): Claude's `CLAUDE.md` convention, Winter's token. */
  instructionsFile: string;
  /** Env-name prefix (WS-01 §2.5). `envName(brand, "HOME")` is the only way product code spells one. */
  envPrefix: string;
  /** macOS Keychain service every `{ kind: "keychain" }` credential ref resolves under (WS-01 §3). */
  keychainService: string;
  /** The standing in-process MCP server's name: `mcp__<mcpServerName>__<tool>` (WS-09 §1.3). */
  mcpServerName: string;
  /** The independently-authored system-prompt preset (WS-11); `preset: "claude_code"` maps onto it. */
  presetName: string;
  /** argv0 / process label for supervised spawns (WS-01 §2.1, D12). */
  processLabel: string;
  /**
   * The codex backend's `originator`. DELIBERATELY NON-FIRST-PARTY and validated as such: sending a
   * vendor's own originator would present Winter as that vendor's client, which is the exact thing
   * WS-01 §3 and the standing hard rule forbid. A reuser must supply their own token, not borrow one.
   */
  codexOriginator: string;
  /** `/private/tmp/<tempRootName>-<uid>/` — the shared per-user temp root (WS-01 §2.3, D18). */
  tempRootName: string;
  /**
   * Winter's own plugin manifest directory (WS-11). NOT `.claude-plugin`: that is the directory the
   * OFFICIAL runtime reads, a Claude-mirroring literal this profile deliberately does not own.
   */
  pluginManifestDir: string;
}

/**
 * The token grammar for the NAME-shaped fields: lowercase, digit- and hyphen-continued, 1..32 chars.
 *
 * Applied to `packageName`, `mcpServerName`, `processLabel`, `tempRootName` and `codexOriginator`
 * and to NOTHING ELSE. `presetName` ("winter_code") has an underscore and is deliberately outside
 * it; the dot-prefixed dirs, the instructions file, the env prefix and the keychain service each
 * have their own shape below. A uniform rule over every field would refuse WINTER_BRAND itself.
 */
export const BRAND_TOKEN_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** `~/.winter`, `<cwd>/.winter`, `.winter-plugin` — a dot then a brand token. */
const DOT_DIR_RE = /^\.[a-z][a-z0-9-]{0,31}$/;
/** `WINTER.md` — Claude's `CLAUDE.md` convention with the reuser's token. */
const INSTRUCTIONS_FILE_RE = /^[A-Z][A-Z0-9_]{0,31}\.md$/;
/** `WINTER_` — the trailing underscore is part of the value, so `envName` is a bare concatenation. */
const ENV_PREFIX_RE = /^[A-Z][A-Z0-9]{0,15}_$/;
/** `com.winter.core` — reverse-DNS-ish, the shape macOS keychain services take. */
const KEYCHAIN_SERVICE_RE = /^[a-z][a-z0-9.-]{0,63}$/;

const MAX_PRODUCT_NAME = 64;

/**
 * Originator values that name a FIRST PARTY. `codexOriginator` may never be one of these.
 *
 * The list is exported so its refusals are testable by iteration rather than by spot check: adding
 * a name here automatically adds a test for it (brand.test.ts loops this array).
 */
export const FIRST_PARTY_ORIGINATORS: readonly string[] = ["codex", "codex_cli_rs", "openai", "anthropic", "claude", "claude-code"];

/** WS-01 §2/§3's own values, byte for byte. Frozen: `resolveBrand()` hands back copies, never this. */
export const WINTER_BRAND: Readonly<BrandProfile> = Object.freeze({
  productName: "Winter",
  packageName: "winter-agent-sdk",
  homeDirName: ".winter",
  projectDirName: ".winter",
  instructionsFile: "WINTER.md",
  envPrefix: "WINTER_",
  keychainService: "com.winter.core",
  mcpServerName: "winter",
  presetName: "winter_code",
  processLabel: "winter",
  codexOriginator: "winter",
  tempRootName: "winter",
  pluginManifestDir: ".winter-plugin",
});

/** A refusal carries WHICH field and WHY, never a bare boolean — the host has to fix something. */
export type BrandValidation = { ok: true; brand: BrandProfile } | { ok: false; reason: string };

interface FieldRule {
  field: keyof BrandProfile;
  re: RegExp;
  shape: string;
}

// Ordered, so a profile wrong in several places always refuses on the same one (a stable message is
// a debuggable message).
const FIELD_RULES: readonly FieldRule[] = [
  { field: "packageName", re: BRAND_TOKEN_RE, shape: "a lowercase token of 1-32 chars: a letter, then letters/digits/hyphens" },
  { field: "mcpServerName", re: BRAND_TOKEN_RE, shape: "a lowercase token of 1-32 chars: a letter, then letters/digits/hyphens" },
  { field: "processLabel", re: BRAND_TOKEN_RE, shape: "a lowercase token of 1-32 chars: a letter, then letters/digits/hyphens" },
  { field: "tempRootName", re: BRAND_TOKEN_RE, shape: "a lowercase token of 1-32 chars: a letter, then letters/digits/hyphens" },
  { field: "codexOriginator", re: BRAND_TOKEN_RE, shape: "a lowercase token of 1-32 chars: a letter, then letters/digits/hyphens" },
  { field: "homeDirName", re: DOT_DIR_RE, shape: "a LEADING DOT then a lowercase token (it names a hidden directory)" },
  { field: "projectDirName", re: DOT_DIR_RE, shape: "a LEADING DOT then a lowercase token (it names a hidden directory)" },
  { field: "pluginManifestDir", re: DOT_DIR_RE, shape: "a LEADING DOT then a lowercase token (it names a hidden directory)" },
  { field: "instructionsFile", re: INSTRUCTIONS_FILE_RE, shape: "an UPPERCASE name with a `.md` extension, e.g. \"ACME.md\"" },
  { field: "envPrefix", re: ENV_PREFIX_RE, shape: "an UPPERCASE prefix ENDING IN AN UNDERSCORE, e.g. \"ACME_\"" },
  { field: "keychainService", re: KEYCHAIN_SERVICE_RE, shape: "a lowercase reverse-DNS-style service name, e.g. \"com.acme.core\"" },
];

/**
 * Fold a host's partial profile onto Winter's defaults and validate the result.
 *
 * ABSENT AND EXPLICITLY-`undefined` ARE THE SAME THING (`exactOptionalPropertyTypes` is on
 * repo-wide, so a caller spreading an options object can legitimately produce either): both mean
 * "keep Winter's value for this field".
 *
 * Returns a RESULT rather than throwing. The one caller that must turn a refusal into a throw is
 * `query()`, which does so as its own typed `InvalidBrandError` at construction time alongside its
 * other option validation; everything else (tests, a host previewing a profile) wants the value.
 */
export function resolveBrand(partial?: Partial<BrandProfile>): BrandValidation {
  const p = partial ?? {};
  const pick = <K extends keyof BrandProfile>(key: K): BrandProfile[K] => (p[key] === undefined ? WINTER_BRAND[key] : (p[key] as BrandProfile[K]));
  // A fresh object every call. A caller that mutates what it got back must not be able to reach the
  // shared constant through it -- and `RuntimeConfig.brand` is serialised per query, so handing out
  // the frozen singleton would also make one host's mutation attempt a cross-session surprise.
  const brand: BrandProfile = {
    productName: pick("productName"),
    packageName: pick("packageName"),
    homeDirName: pick("homeDirName"),
    projectDirName: pick("projectDirName"),
    instructionsFile: pick("instructionsFile"),
    envPrefix: pick("envPrefix"),
    keychainService: pick("keychainService"),
    mcpServerName: pick("mcpServerName"),
    presetName: pick("presetName"),
    processLabel: pick("processLabel"),
    codexOriginator: pick("codexOriginator"),
    tempRootName: pick("tempRootName"),
    pluginManifestDir: pick("pluginManifestDir"),
  };

  for (const key of Object.keys(brand) as Array<keyof BrandProfile>) {
    if (typeof brand[key] !== "string") return { ok: false, reason: `brand.${key}: expected a string, got ${brand[key] === null ? "null" : typeof brand[key]}` };
  }
  if (brand.productName.length === 0 || brand.productName.length > MAX_PRODUCT_NAME) {
    return { ok: false, reason: `brand.productName: expected 1-${MAX_PRODUCT_NAME} characters, got ${brand.productName.length}` };
  }
  // `presetName` has no grammar rule ON PURPOSE (see BRAND_TOKEN_RE's own comment): Winter's own
  // value contains an underscore. Non-empty is the whole check.
  if (brand.presetName.length === 0) return { ok: false, reason: "brand.presetName: expected a non-empty preset name" };
  for (const rule of FIELD_RULES) {
    const value = brand[rule.field];
    if (!rule.re.test(value)) return { ok: false, reason: `brand.${rule.field}: ${JSON.stringify(value)} is not ${rule.shape}` };
  }
  if (FIRST_PARTY_ORIGINATORS.includes(brand.codexOriginator)) {
    return {
      ok: false,
      reason:
        `brand.codexOriginator: ${JSON.stringify(brand.codexOriginator)} is a first-party value. ` +
        `The originator field names the CLIENT, and sending a vendor's own name presents this software as that vendor's tool — ` +
        `supply your own token instead (one of: ${FIRST_PARTY_ORIGINATORS.join(", ")} is never it).`,
    };
  }
  return { ok: true, brand };
}

/**
 * The ONLY way product code spells a brand-derived environment variable.
 *
 * `envName(brand, "HOME")` -> `"WINTER_HOME"`. Takes a `Pick` so a caller holding one field (a
 * partially-threaded config, a test) can call it without constructing a whole profile.
 */
export function envName(brand: Pick<BrandProfile, "envPrefix">, suffix: string): string {
  return `${brand.envPrefix}${suffix}`;
}

/** `mcpToolName(brand, "send_message")` -> `"mcp__winter__send_message"` (WS-09 §1.3's canonical form). */
export function mcpToolName(brand: Pick<BrandProfile, "mcpServerName">, tool: string): string {
  return `mcp__${brand.mcpServerName}__${tool}`;
}

/** `userAgent(brand, "0.0.1")` -> `"winter-agent-sdk/0.0.1"` — the honest identity on every wire. */
export function userAgent(brand: Pick<BrandProfile, "packageName">, version: string): string {
  return `${brand.packageName}/${version}`;
}
