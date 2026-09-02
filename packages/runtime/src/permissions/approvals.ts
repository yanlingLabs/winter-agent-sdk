// Task 11 (WS-07 §9; WS-08 §7): the durable approval store — what a `defer` decision (runner.ts /
// hook-stage.ts / evaluator.ts, this same task) actually parks into. Mirrors ruleset.ts's own
// `appendPermissionJournal`/`appendHookAuditJournal` atomic-append + secure-dir discipline
// (ensureSecureJournalDir/ensureJournalDirChain/appendJsonLine/writeAllSync/realUid/
// assertSafePathSegment below are a DELIBERATE, small duplication of that file's own private
// helpers — same precedent ruleset.ts itself already set for `writeAllSync` against
// packages/sdk/src/store/leases.ts: "small and duplicated deliberately, not because the logic is
// complex," here because this task's edit authorization does not extend to exporting ruleset.ts's
// private helpers, and because a THIRD near-identical copy is cheaper than a cross-module coupling
// neither file otherwise needs). Storage home: `<sessionId>.approvals.jsonl`, store-adjacent
// (SAME `<winterHome>/projects/<projectKey>/` directory the session's own `<sessionId>.jsonl` and
// `<sessionId>.permission-journal.jsonl` already live in), runtime-private (0700 dirs / 0600 file,
// identical to the permission journal).
//
// WS-07 §9's own record shape is a MINIMUM, not a ceiling (its own prose: "Winter's durable approval
// record (minimum)"). This file extends it with fields the minimum names but does not shape
// (`issuedCwd`/`issuedHome`, needed for the "normalized paths/destinations" revalidation axis) and
// with fields P2's own resume-consumption design needs that the spec never mentions at all
// (`resolution` — provenance-preserving response bookkeeping, WS-08 §7.4's "without erasing which
// mechanism answered"; `consumedAt`/`consumedResult`/`consumedIsError` — the exactly-once execution
// guard a resumed run needs so a SECOND resume never re-runs a side-effecting tool). Every extension
// is additive to the pinned `state` enum's five literal values, never a sixth state value — see each
// field's own comment.
//
// T8-CARRY (decisionClassification consumer, task-9/10 review carry): `ApprovalResponseInput` below
// accepts and PERSISTS `decisionClassification` on `.resolution` — T8 threaded this field faithfully
// through PromptDecision/PermissionDecisionRecord but nothing downstream ever READ it (T8's own
// review, finding 3). This store is that consumer: WS-07 §7.2's "distinguishes allow-once/durable/
// reject for audit" is realized here, on the resolution of a durable approval, per this task's brief.
import { mkdirSync, lstatSync, chmodSync, openSync, writeSync, fsyncSync, closeSync, readFileSync, constants as fsConstants } from "node:fs";
import { join, resolve } from "node:path";
import type { PermissionMode, PermissionUpdate, RuleSource, PermissionDecisionClassification } from "@yanlinglabs/winter-agent-sdk";

// --- WS-07 §9 verbatim minimum shape, plus this task's documented extensions (see header) ----------

export interface DurableApprovalDisplayMetadata {
  decisionReason: string;
  blockedPath?: string;
}

export interface ApprovalResolution {
  mechanism: "hook" | "canUseTool" | "system";
  at: string; // ISO 8601
  message?: string;
  // A responder's own sanitized/narrowed/redirected input — the durable analog of canUseTool's
  // `updatedInput` (WS-07 §7.2); resume execution uses this over `originalInput` when present (see
  // engine.ts's own resume-consumption step, this task).
  transformedInput?: Record<string, unknown>;
  updatedPermissions?: PermissionUpdate[];
  // T8-CARRY consumption (see this file's header) — persisted, never reapplied to live policy at
  // P2 (capture-noted deviation; see this task's report).
  decisionClassification?: PermissionDecisionClassification;
  // System-driven transitions (cancel on mode switch, expire on revalidation mismatch) use this
  // instead of `message` — kept as a separate field so a human-authored deny message is never
  // confused with a system-authored bookkeeping reason.
  reason?: string;
}

export interface DurableApprovalRecord {
  // --- WS-07 §9 verbatim minimum ---
  runtimeKind: string;
  sessionId: string;
  backendSessionId: string;
  requestId: string;
  toolUseID: string;
  agentID?: string;
  toolName: string;
  originalInput: Record<string, unknown>;
  displayMetadata: DurableApprovalDisplayMetadata;
  permissionSuggestions?: PermissionUpdate[];
  matchedAskRule?: { source: RuleSource; toolName: string; ruleContent?: string };
  policyMode: PermissionMode;
  policyVersion: number;
  issuedAt: string; // ISO 8601
  expiresAt?: string;
  state: "pending" | "allowed" | "denied" | "cancelled" | "expired";

  // --- Winter P2 extensions (this file's header) ---
  issuedCwd: string;
  issuedHome: string;
  resolution?: ApprovalResolution;
  consumedAt?: string;
  consumedResult?: string;
  consumedIsError?: boolean;
}

// The constant this runtime stamps into every record it issues (WS-15's own naming: "runtimeKind
// 'winter-agent' -> @yanlinglabs/winter-agent-sdk -> winter runtime"). Exported so engine.ts never
// hand-copies the string.
export const WINTER_RUNTIME_KIND = "winter-agent";

// --- respond() -----------------------------------------------------------------------------------

export interface ApprovalResponseInput {
  outcome: "allowed" | "denied";
  mechanism: "hook" | "canUseTool" | "system";
  message?: string;
  transformedInput?: Record<string, unknown>;
  updatedPermissions?: PermissionUpdate[];
  decisionClassification?: PermissionDecisionClassification;
}

export interface RespondResult {
  // false = first-response-wins already settled this requestId (or none exists) — a typed no-op,
  // never a throw (WS-07 §9: "a second response is a typed no-op").
  applied: boolean;
  record: DurableApprovalRecord;
}

export class DurableApprovalStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DurableApprovalStoreError";
  }
}

// --- revalidate() — pure, no I/O (WS-07 §9: "session, tool call, mode/policy version, normalized
// paths/destinations, runtime ownership — ANY mismatch -> expired, never execute") ------------------

export interface RevalidationContext {
  runtimeKind: string;
  sessionId: string;
  backendSessionId: string;
  toolUseID: string;
  policyMode: PermissionMode;
  policyVersion: number;
  cwd: string;
  home: string;
}

export type RevalidationAxis = "session" | "toolCall" | "policy" | "paths" | "runtime";

export type RevalidationVerdict = { ok: true } | { ok: false; axis: RevalidationAxis; reason: string };

// Best-effort target extraction for the "normalized paths/destinations" axis — deliberately NOT
// evaluator.ts's full `recognizeEditOperation`/`extractCandidateWritePaths` parity (that machinery
// is the PERMISSION STAGE's own concern, over the tool registry WS-06 eventually supplies; this
// axis only needs a "did the MEANING of this already-fixed input change under a new cwd/home"
// signal for the tool shapes P2 actually defers). A tool with no recognized target here always
// compares equal (vacuously "unchanged") — never a false mismatch for a shape this function does
// not understand yet; documented scope limitation, capture-noted in the task report.
function extractNormalizedTargets(toolName: string, input: Record<string, unknown>, ctx: { cwd: string; home: string }): string[] {
  if ((toolName === "Edit" || toolName === "Write") && typeof input["file_path"] === "string") {
    return [resolve(ctx.cwd, input["file_path"])];
  }
  if (toolName === "WebFetch" && typeof input["url"] === "string") {
    return [input["url"].toLowerCase()];
  }
  void ctx.home; // reserved for a future `~`-anchored target shape; unused today, kept for symmetry with cwd
  return [];
}

export function revalidateApproval(approval: DurableApprovalRecord, ctx: RevalidationContext): RevalidationVerdict {
  if (approval.sessionId !== ctx.sessionId) {
    return { ok: false, axis: "session", reason: `session mismatch: approval issued for session ${approval.sessionId}, current session is ${ctx.sessionId}` };
  }
  if (approval.toolUseID !== ctx.toolUseID) {
    return { ok: false, axis: "toolCall", reason: `tool call mismatch: approval is for toolUseID ${approval.toolUseID}, current toolUseID is ${ctx.toolUseID}` };
  }
  if (approval.policyMode !== ctx.policyMode || approval.policyVersion !== ctx.policyVersion) {
    return {
      ok: false,
      axis: "policy",
      reason: `policy drift: approval issued under mode=${approval.policyMode}/version=${approval.policyVersion}, current mode=${ctx.policyMode}/version=${ctx.policyVersion}`,
    };
  }
  const issuedTargets = extractNormalizedTargets(approval.toolName, approval.originalInput, { cwd: approval.issuedCwd, home: approval.issuedHome });
  const currentTargets = extractNormalizedTargets(approval.toolName, approval.originalInput, { cwd: ctx.cwd, home: ctx.home });
  if (issuedTargets.join(" ") !== currentTargets.join(" ")) {
    return {
      ok: false,
      axis: "paths",
      reason: `normalized target drift: issued against [${issuedTargets.join(", ")}], now resolves to [${currentTargets.join(", ")}]`,
    };
  }
  if (approval.runtimeKind !== ctx.runtimeKind || approval.backendSessionId !== ctx.backendSessionId) {
    return {
      ok: false,
      axis: "runtime",
      reason: `runtime ownership mismatch: approval belongs to ${approval.runtimeKind}/${approval.backendSessionId}, current runtime is ${ctx.runtimeKind}/${ctx.backendSessionId}`,
    };
  }
  return { ok: true };
}

// --- DurableApprovalStore — the interface both implementations below satisfy ------------------------

export interface SessionKeyLike {
  sessionId: string;
}

export interface ConsumedResultInput {
  output: string;
  isError?: boolean;
}

export interface DurableApprovalStore {
  record(approval: DurableApprovalRecord): void;
  // First-response-wins (WS-07 §9). Throws DurableApprovalStoreError for an unknown requestId —
  // never a silent no-op for a typo/programming error, unlike the SETTLED-first-wins no-op below
  // (that one is legitimate, expected, load-bearing behavior for a genuine race; an unknown
  // requestId is not). Synchronous (matching ruleset.ts's own permission/hook journal convention,
  // which this store mirrors) on BOTH implementations below — a future async-backed store is a
  // signature change for whichever task actually needs one, not hedged here.
  respond(requestId: string, response: ApprovalResponseInput): RespondResult;
  // Every record currently in state "pending" for this session — literal to the method's own name;
  // `listFor` (below) is the broader "every state" accessor a resume scan needs.
  pendingFor(sessionKey: SessionKeyLike): DurableApprovalRecord[];
  listFor(sessionKey: SessionKeyLike): DurableApprovalRecord[];
  get(requestId: string): DurableApprovalRecord | undefined;
  // Pure per WS-07 §9 (see revalidateApproval above) — this method is a thin delegate so a caller
  // holding only a DurableApprovalStore (not the free function) still has it, per the brief's own
  // literal interface listing.
  revalidate(approval: DurableApprovalRecord, ctx: RevalidationContext): RevalidationVerdict;
  // Mode-switch semantics (WS-07 §2): cancels every currently-pending record for this session.
  // First-transition-wins applies here too (a record already resolved by the time this runs is
  // left untouched) — never throws for "nothing pending," a no-op is the expected common case.
  cancelPendingFor(sessionKey: SessionKeyLike, reason: string): void;
  // Revalidation-mismatch-driven transition (resume path). Applies only from "pending" or
  // "allowed" AND not yet consumed (an already-consumed "allowed" record already executed —
  // expiring it after the fact would be meaningless; see engine.ts's own resume-scan ordering).
  // A requestId that is already terminal-and-inapplicable is a silent no-op, not an error: the
  // resume scan calls this defensively without first re-checking state itself.
  expire(requestId: string, reason: string): void;
  // Exactly-once execution bookkeeping for an "allowed" record (this task's own resume-consumption
  // design, capture-noted — WS-07 §9 names no such state). Idempotent: a second call for the same
  // requestId is a no-op (the FIRST recorded result wins, mirroring respond()'s own first-wins
  // posture) so a resumed run can call this unconditionally after executing.
  markConsumed(requestId: string, result: ConsumedResultInput): void;
}

// --- Shared envelope-fold core (both implementations replay the SAME envelope shapes) ---------------

type ApprovalEnvelope =
  | { kind: "record"; approval: DurableApprovalRecord }
  | { kind: "response"; requestId: string; response: ApprovalResponseInput; at: string }
  | { kind: "cancel"; requestId: string; reason: string; at: string }
  | { kind: "expire"; requestId: string; reason: string; at: string }
  | { kind: "consumed"; requestId: string; result: ConsumedResultInput; at: string };

// Applies ONE envelope to the in-memory map, honoring every "first transition wins" / "already
// consumed" guard described on DurableApprovalStore's own method comments above. Shared by BOTH the
// initial disk replay (fold every historical line) and a fresh in-process mutation (apply the one
// envelope just appended) — the two paths can never disagree about what a given envelope means,
// because there is only one interpreter.
function applyEnvelope(map: Map<string, DurableApprovalRecord>, envelope: ApprovalEnvelope): void {
  if (envelope.kind === "record") {
    if (!map.has(envelope.approval.requestId)) map.set(envelope.approval.requestId, envelope.approval);
    return;
  }
  const current = map.get(envelope.requestId);
  if (current === undefined) return; // an envelope for a requestId this map never saw a "record" for -- inert, not an error (replay tolerance)

  if (envelope.kind === "response") {
    if (current.state !== "pending") return; // first-response-wins
    const resolution: ApprovalResolution = {
      mechanism: envelope.response.mechanism,
      at: envelope.at,
      ...(envelope.response.message !== undefined ? { message: envelope.response.message } : {}),
      ...(envelope.response.transformedInput !== undefined ? { transformedInput: envelope.response.transformedInput } : {}),
      ...(envelope.response.updatedPermissions !== undefined ? { updatedPermissions: envelope.response.updatedPermissions } : {}),
      ...(envelope.response.decisionClassification !== undefined ? { decisionClassification: envelope.response.decisionClassification } : {}),
    };
    map.set(envelope.requestId, { ...current, state: envelope.response.outcome === "allowed" ? "allowed" : "denied", resolution });
    return;
  }
  if (envelope.kind === "cancel") {
    if (current.state !== "pending") return;
    map.set(envelope.requestId, { ...current, state: "cancelled", resolution: { mechanism: "system", at: envelope.at, reason: envelope.reason } });
    return;
  }
  if (envelope.kind === "expire") {
    if (current.state !== "pending" && current.state !== "allowed") return;
    if (current.consumedAt !== undefined) return; // already executed -- never retroactively expire a completed call
    map.set(envelope.requestId, { ...current, state: "expired", resolution: { mechanism: "system", at: envelope.at, reason: envelope.reason } });
    return;
  }
  // "consumed"
  if (current.consumedAt !== undefined) return; // first-execution-wins -- see markConsumed's own comment
  map.set(envelope.requestId, {
    ...current,
    consumedAt: envelope.at,
    consumedResult: envelope.result.output,
    ...(envelope.result.isError === true ? { consumedIsError: true } : {}),
  });
}

function filterAndSort(map: Map<string, DurableApprovalRecord>, sessionKey: SessionKeyLike, statePredicate?: (r: DurableApprovalRecord) => boolean): DurableApprovalRecord[] {
  const out: DurableApprovalRecord[] = [];
  for (const record of map.values()) {
    if (record.sessionId !== sessionKey.sessionId) continue;
    if (statePredicate && !statePredicate(record)) continue;
    out.push(record);
  }
  out.sort((a, b) => a.issuedAt.localeCompare(b.issuedAt));
  return out;
}

// --- In-memory implementation — tests / non-persistent sessions (mirrors NO_OPINION_*'s own
// "byte-identical contract, no fs" precedent elsewhere in this phase) --------------------------------

export function createInMemoryApprovalStore(): DurableApprovalStore {
  const map = new Map<string, DurableApprovalRecord>();
  const apply = (envelope: ApprovalEnvelope): void => applyEnvelope(map, envelope);

  return {
    record(approval) {
      apply({ kind: "record", approval });
    },
    respond(requestId, response) {
      const before = map.get(requestId);
      if (before === undefined) throw new DurableApprovalStoreError(`respond(): no such durable approval requestId: ${requestId}`);
      const applied = before.state === "pending";
      apply({ kind: "response", requestId, response, at: new Date().toISOString() });
      return { applied, record: map.get(requestId)! };
    },
    pendingFor(sessionKey) {
      return filterAndSort(map, sessionKey, (r) => r.state === "pending");
    },
    listFor(sessionKey) {
      return filterAndSort(map, sessionKey);
    },
    get(requestId) {
      return map.get(requestId);
    },
    revalidate(approval, ctx) {
      return revalidateApproval(approval, ctx);
    },
    cancelPendingFor(sessionKey, reason) {
      const at = new Date().toISOString();
      for (const record of filterAndSort(map, sessionKey, (r) => r.state === "pending")) {
        apply({ kind: "cancel", requestId: record.requestId, reason, at });
      }
    },
    expire(requestId, reason) {
      apply({ kind: "expire", requestId, reason, at: new Date().toISOString() });
    },
    markConsumed(requestId, result) {
      apply({ kind: "consumed", requestId, result, at: new Date().toISOString() });
    },
  };
}

// --- File-backed implementation — <sessionId>.approvals.jsonl, store-adjacent, runtime-private -----
//
// Directory/file discipline mirrors ruleset.ts's appendPermissionJournal/appendHookAuditJournal
// EXACTLY (same per-level symlink/ownership/mode checks, same O_APPEND|O_CREAT|O_WRONLY|O_NOFOLLOW +
// fsync + self-healing chmod 0600 append) — see this file's own header for why it is a deliberate
// local duplication rather than an import.

function assertSafePathSegment(value: string, label: string): void {
  if (value === "" || value === "." || value === ".." || value.includes("/")) {
    throw new DurableApprovalStoreError(`${label} must be a single, non-empty, non-traversal path segment: ${JSON.stringify(value)}`);
  }
}

function writeAllSync(fd: number, buf: Buffer): void {
  let written = 0;
  while (written < buf.length) {
    written += writeSync(fd, buf, written, buf.length - written);
  }
}

const APPEND_FLAGS = fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW;

function realUid(): number {
  return process.getuid!(); // POSIX-only, Bun-only + macOS-first runtime -- same precedent as ruleset.ts's own realUid
}

function ensureSecureDir(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (err) {
    if ((err as { code?: unknown }).code !== "EEXIST") throw err;
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new DurableApprovalStoreError(`refusing a symlink at a level the durable approval store must own: ${path}`);
  if (!stat.isDirectory()) throw new DurableApprovalStoreError(`expected a directory, found something else at: ${path}`);
  if (stat.uid !== realUid()) throw new DurableApprovalStoreError(`refusing a directory owned by a different uid: ${path}`);
  chmodSync(path, 0o700);
}

export interface ApprovalStoreLocation {
  winterHome: string;
  projectKey: string;
  sessionId: string;
}

function projectDir(location: { winterHome: string; projectKey: string }): string {
  assertSafePathSegment(location.projectKey, "projectKey");
  return join(location.winterHome, "projects", location.projectKey);
}

function approvalsPath(location: ApprovalStoreLocation): string {
  assertSafePathSegment(location.sessionId, "sessionId");
  return join(projectDir(location), `${location.sessionId}.approvals.jsonl`);
}

function ensureDirChain(location: { winterHome: string; projectKey: string }): void {
  const projectsDir = join(location.winterHome, "projects");
  for (const level of [location.winterHome, projectsDir, projectDir(location)]) ensureSecureDir(level);
}

function appendJsonLine(path: string, value: unknown): void {
  const data = Buffer.from(JSON.stringify(value) + "\n", "utf8");
  const fd = openSync(path, APPEND_FLAGS, 0o600);
  try {
    writeAllSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
}

// Missing file/dir -> empty map (a session that never deferred anything has no approvals file at
// all — the same "nothing there yet" posture SessionStore.load() gives for a session with no
// transcript). Any OTHER read failure (permissions, a real I/O error) is not swallowed.
function loadExisting(path: string): Map<string, DurableApprovalRecord> {
  const map = new Map<string, DurableApprovalRecord>();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return map;
    throw err;
  }
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    const envelope = JSON.parse(line) as ApprovalEnvelope;
    applyEnvelope(map, envelope);
  }
  return map;
}

// Synchronous factory (matching ruleset.ts's own appendPermissionJournal/appendHookAuditJournal
// synchronous-fs convention) — loads whatever this session has already persisted, once, at
// construction; every subsequent mutation appends one new envelope AND folds it into the same
// in-memory map (applyEnvelope is the single source of truth for what an envelope means, shared
// with the initial load above, so a freshly-constructed store and a long-lived one never disagree).
export function createFileDurableApprovalStore(location: ApprovalStoreLocation): DurableApprovalStore {
  const path = approvalsPath(location);
  const map = loadExisting(path);

  const persistAndApply = (envelope: ApprovalEnvelope): void => {
    ensureDirChain(location);
    appendJsonLine(path, envelope);
    applyEnvelope(map, envelope);
  };

  return {
    record(approval) {
      persistAndApply({ kind: "record", approval });
    },
    respond(requestId, response) {
      const before = map.get(requestId);
      if (before === undefined) throw new DurableApprovalStoreError(`respond(): no such durable approval requestId: ${requestId}`);
      const applied = before.state === "pending";
      persistAndApply({ kind: "response", requestId, response, at: new Date().toISOString() });
      return { applied, record: map.get(requestId)! };
    },
    pendingFor(sessionKey) {
      return filterAndSort(map, sessionKey, (r) => r.state === "pending");
    },
    listFor(sessionKey) {
      return filterAndSort(map, sessionKey);
    },
    get(requestId) {
      return map.get(requestId);
    },
    revalidate(approval, ctx) {
      return revalidateApproval(approval, ctx);
    },
    cancelPendingFor(sessionKey, reason) {
      const at = new Date().toISOString();
      for (const record of filterAndSort(map, sessionKey, (r) => r.state === "pending")) {
        persistAndApply({ kind: "cancel", requestId: record.requestId, reason, at });
      }
    },
    expire(requestId, reason) {
      persistAndApply({ kind: "expire", requestId, reason, at: new Date().toISOString() });
    },
    markConsumed(requestId, result) {
      persistAndApply({ kind: "consumed", requestId, result, at: new Date().toISOString() });
    },
  };
}
