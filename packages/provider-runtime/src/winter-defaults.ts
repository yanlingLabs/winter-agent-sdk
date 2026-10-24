// 0.0.56 (W9): the few values and shapes this package used to IMPORT from `@yanlinglabs/winter-agent-sdk`.
//
// WHY THEY ARE DECLARED HERE NOW. `@yanlinglabs/winter-agent-sdk` carries the compiled `winter` runtime
// binary as an `optionalDependency` (`@yanlinglabs/winter-agent-sdk-darwin-arm64`, ~71 MB). While this
// package listed the sdk as a runtime dependency, every host that used only the provider layer -- an
// in-process agent loop over `streamTurn`, under Node, on any platform -- installed the wrapper and,
// on darwin-arm64, the binary, for four constants and three type shapes. This package now depends on
// `@yanlinglabs/winter-provider-catalog` alone; `scripts/provider-pack-closure.test.ts` packs it and
// refuses a manifest that names the sdk (or the platform package) as a dependency again.
//
// ONE MEANING, TWO DECLARATIONS, AND A GATE THAT KEEPS THEM ONE. The sdk stays the owner of these
// values (its brand profile and its public `Options`/`Query` shapes), and the sdk is dependency-free by
// rule, so it cannot import them from here either. `winter-defaults.test.ts` imports the sdk (a dev
// dependency only) and asserts every value equal and every type mutually assignable, so a change on
// either side fails this package's own tests rather than drifting silently.

/**
 * Winter's own wire identity -- the sdk's `WINTER_BRAND.packageName`, `.codexOriginator` and
 * `.contactUrl`, byte for byte. What `activeWinterIdentity()` returns until a host installs its own
 * (`setWinterIdentity`).
 */
export const WINTER_DEFAULT_IDENTITY: Readonly<{ product: string; codexOriginator: string; contactUrl: string }> = Object.freeze({
  product: "winter-agent-sdk",
  codexOriginator: "winter",
  contactUrl: "https://github.com/yanlingLabs/winter-agent-sdk",
});

/** The sdk's `WINTER_BRAND.instructionsFile`: Winter's own instructions file name. */
export const WINTER_INSTRUCTIONS_FILE = "WINTER.md";

/** The sdk's `DEFAULT_COMPACTION_THRESHOLD`: the fraction of a context window at which the engine compacts. */
export const WINTER_DEFAULT_COMPACTION_THRESHOLD = 0.92;

/**
 * Originator values that name a FIRST PARTY -- the sdk's `FIRST_PARTY_ORIGINATORS`. A host identity
 * whose `codexOriginator` is one of these is refused by `setWinterIdentity`.
 */
export const FIRST_PARTY_ORIGINATORS: readonly string[] = Object.freeze(["codex", "codex_cli_rs", "openai", "anthropic", "claude", "claude-code"]);

/**
 * R6-10: an OPAQUE reference to credential material, never the material itself -- the sdk's
 * `CredentialRef` (protocol/config.ts), structurally identical.
 *
 * - `keychain` -- one record per provider/account. A Keychain-backed store is the host's to supply;
 *   this package ships none.
 * - `env` -- a host NAMES the variable explicitly. Ambient keys are never scanned.
 * - `file` -- a shared-credentials file, a GCP service-account JSON, or a raw single-value file.
 * - `inline` -- a host responsibility: never persisted, redacted in every frame and log.
 * - `aws-default-chain` -- env + shared-credentials file only (no IMDS/STS).
 * - `none` -- a local endpoint that needs no credential.
 */
export type CredentialRef =
  | { kind: "keychain"; account: string; service?: string }
  | { kind: "env"; name: string }
  | { kind: "file"; path: string; format: "aws-shared-credentials" | "gcp-service-account-json" | "raw"; profile?: string }
  | { kind: "inline"; value: string }
  | { kind: "aws-default-chain" }
  | { kind: "none" };

/**
 * The pinned `ModelInfo` -- the sdk's `ModelInfo` (protocol/config.ts), structurally identical: three
 * required fields, six optional, each capability boolean OMITTED when unknown rather than `false`.
 */
export interface ModelInfo {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: Array<"low" | "medium" | "high" | "xhigh" | "max">;
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
}

/** One stored transcript entry -- the sdk's `SessionStoreEntry` (store/session-store.ts), structurally identical. */
export type SessionStoreEntry = { type: string; uuid?: string; timestamp?: string; [key: string]: unknown };
