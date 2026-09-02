export { query } from "./query.ts";
export type { Query, SdkMessage } from "./query.ts";
// Task 2 (WS-04 §3.1): the wrapper's control-request handler registry types — QueryInternal is the
// shape behind the Winter-only `Query.__internal` extension (never part of the WS-03 pinned
// surface; T8 adds `respondPermission` to it for the canUseTool `null` escape).
export type { QueryInternal, ControlRequestHandler, ControlRequestHandlerResult } from "./query.ts";
export type { Options } from "./options.ts";
export {
  WinterSDKError,
  CLIConnectionError,
  ProcessError,
  ResultError,
  ProtocolDecodeError,
  AbortError,
  SessionNotFoundError,
  WinterRpcError,
  WinterRpcTimeoutError,
} from "./errors.ts";

// The pinned process seam (WS-04 §8) — byte-level SpawnedRuntimeProcess handle, shared by the real
// child transport and winter-agent-runtime/testing's in-memory transport (Task 2).
export { resolveRuntimeExecutable, defaultSpawn } from "./transport.ts";
export type { SpawnedRuntimeProcess, SpawnRuntimeOptions, SpawnClaudeCodeProcess } from "./transport.ts";
export type { RuntimeConfig } from "./protocol/config.ts";

// Wire protocol (WS-02 §3: owned by the sdk, the runtime depends on it — never the reverse).
// Previously reachable only via the runtime; now the sdk's own public surface.
export { encodeFrame, decodeFrame, splitFrames, ProtocolError } from "./protocol/codec.ts";
export { PROTOCOL_VERSION } from "./protocol/frames.ts";
// Aliased: `SdkMessage` above is query()'s CLOSED result union (WS-03 §8). This is the wire-level
// OPEN union frames carry (system/assistant/result + a lossless unknown-kind catch-all) — the two
// can't share a name in one barrel.
export type {
  ProtocolVersion,
  WinterFrame,
  SdkMessage as ProtocolSdkMessage,
  InitFrame,
  UserFrame,
  DataFrame,
  ControlRequestFrame,
  ControlResponseFrame,
  UnknownFrame,
} from "./protocol/frames.ts";

// Paths (Task 6, moved here Task 10 -- WS-05 §6): WINTER_HOME resolution, the exact CC-compatible
// project-key algorithm, and the git-aware compatibility-key triple. dialect.ts/temp.ts/
// project-dir-name.ts stay runtime-private; the runtime imports resolveWinterHome/
// compatibilityKeys/isUnset back from here (packages/runtime/src/index.ts re-exports them
// unchanged for its own existing consumers).
export { resolveWinterHome, isUnset } from "./paths/home.ts";
export { transcriptProjectKey } from "./paths/project-key.ts";
export { compatibilityKeys } from "./paths/keys.ts";
export type { CompatibilityKeys } from "./paths/keys.ts";

// The filesystem SessionStore (Task 7, moved here Task 10 -- WS-05 §6: the store is
// public-adjacent, published-package code, not engine logic -- WS-14 needs it from this package
// for the official branch's own `sessionStore` option). Pinned WS-03 §10 SessionStore/SessionKey/
// SessionStoreEntry/SessionSummaryEntry type family plus the concrete filesystem-backed store and
// its typed errors (leases.ts).
export {
  WinterCompatibilitySessionStore,
  WinterStoreError,
  WinterStoreLeaseError,
  DIALECT_RECORD_ENTRY_TYPE,
} from "./store/session-store.ts";
export type { SessionKey, SessionStoreEntry, SessionSummaryEntry, SessionStore } from "./store/session-store.ts";

// Task 10: the store-level fork primitive (WS-05 §7's forkSession-on-resume half) relocated
// alongside the store. Named forkSessionByKey here to avoid colliding with the public
// `forkSession(sessionId, opts)` standalone function below, which wraps it after resolving a bare
// sessionId; the runtime's dialect.ts imports this directly for its own resume orchestration.
export { forkSessionByKey } from "./store/fork-session.ts";

// Task 10 (WS-03 §3.1): the standalone session-management API.
export {
  listSessions,
  getSessionInfo,
  getSessionMessages,
  renameSession,
  tagSession,
  deleteSession,
  forkSession,
  listSubagents,
  getSubagentMessages,
} from "./sessions.ts";

// Task 3 (WS-07 §3.3/§4): permissions surface, pinned-types home. See permissions/types.ts's own
// header for the section boundaries later tasks (5, 8) extend.
export type { PermissionMode, PermissionBehavior, PermissionRuleValue } from "./permissions/types.ts";
