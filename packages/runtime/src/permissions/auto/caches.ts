// Task 12 (WS-07 §10.5/§10.6-10/§10.6-11): verdict caches + the 3-consecutive/20-total fallback
// counters. Two independent concerns share this file because both are keyed/hashed the same way
// and both are "small persisted auto-mode state," mirroring how approvals.ts owns everything the
// durable-approval record needs in one place.
import { createHash } from "node:crypto";
import { mkdirSync, lstatSync, chmodSync, readFileSync, renameSync, fsyncSync, openSync, closeSync, writeSync, constants as fsConstants } from "node:fs";
import { join, dirname } from "node:path";
import type { PolicyState } from "../policy-state.ts";
import type { PermissionCall, AutoEngineVerdict } from "../evaluator.ts";

// ---------------------------------------------------------------------------------------------
// Stable hashing (policyHash / envHash / action fingerprint) -- WS-07 §10.5: "Winter keys network
// verdicts at least by host, port, policy hash, trust-environment hash, session, and conversation
// generation; never reuses an allow across ... materially different arguments."
// ---------------------------------------------------------------------------------------------

// Deterministic regardless of key insertion order -- a plain JSON.stringify of an object is NOT
// stable across differently-ordered callers, which would make two logically-identical policies
// hash differently by accident (a correctness bug for a CACHE key, not just a cosmetic one).
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

// "policy hash": the CONTENT of what governs a decision (mode + rules + autoConfig), independent
// of the monotonic `version` counter -- two sessions with identical rules get the identical hash
// even though their own `version` counters are unrelated small integers. `version` itself is
// deliberately EXCLUDED (it is a per-session counter, not policy content; sessionId already
// separates sessions in the cache key, see AutoVerdictCacheKey below).
export function computePolicyHash(policy: Pick<PolicyState, "mode" | "rules" | "autoConfig">): string {
  return stableHash({
    mode: policy.mode,
    entries: policy.rules.entries.map((e) => ({ toolName: e.rule.toolName, specifier: e.rule.specifier, behavior: e.behavior, source: e.source })),
    autoConfig: policy.autoConfig,
  });
}

export interface EnvHashInputs {
  cwd: string;
  home: string;
  trustedWorkspace: boolean;
  sessionBypassEnabled?: boolean;
  additionalDirectories?: string[];
}

// "trust-environment hash" (WS-07 §10.5) -- the session's trust-shaping facts, independent of the
// rule set itself (policyHash already covers rules/mode/autoConfig).
export function computeEnvHash(inputs: EnvHashInputs): string {
  return stableHash({
    cwd: inputs.cwd,
    home: inputs.home,
    trustedWorkspace: inputs.trustedWorkspace,
    sessionBypassEnabled: inputs.sessionBypassEnabled === true,
    additionalDirectories: [...(inputs.additionalDirectories ?? [])].sort(),
  });
}

// "never reuses ... across materially different arguments" -- the network-shaped {host,port} key
// alone is not enough for a generic (non-network) action; this fingerprints the actual call so two
// DIFFERENT commands/inputs under the identical tool never collide in the cache.
export function computeActionFingerprint(call: PermissionCall): string {
  return stableHash({ toolName: call.toolName, input: call.input });
}

// ---------------------------------------------------------------------------------------------
// Verdict cache (WS-07 §10.5/§10.6-10)
// ---------------------------------------------------------------------------------------------
//
// DESIGN: the cache key is a plain object; invalidation is achieved BY CONSTRUCTION (never an
// explicit "clear" call) -- every axis the spec's own invalidation matrix names is already a KEY
// COMPONENT: a mode/rule/environment change changes policyHash/envHash (new content is
// unreachable under the old key); "new content/turn/compaction" is `generation`, bumped by the
// caller (no compaction/turn-counter concept reaches this file at P2 -- callers that have no such
// signal yet pass a constant `0`, documented at the one production call site in auto/engine.ts).
// A stale entry is simply never looked up again once any component changes; nothing needs active
// eviction for CORRECTNESS (memory growth over a long session is a real but separate concern, not
// in this task's scope).
export interface AutoVerdictCacheKey {
  host?: string;
  port?: number;
  policyHash: string;
  envHash: string;
  sessionId: string;
  generation: number;
  actionFingerprint: string;
}

export interface AutoVerdictCacheEntry {
  verdict: AutoEngineVerdict;
  cachedAt: string; // ISO 8601, audit/debugging only -- never consulted for expiry (generation is the expiry mechanism)
}

export interface AutoVerdictCache {
  get(key: AutoVerdictCacheKey): AutoVerdictCacheEntry | undefined;
  set(key: AutoVerdictCacheKey, entry: AutoVerdictCacheEntry): void;
}

function cacheKeyString(key: AutoVerdictCacheKey): string {
  return stableStringify(key);
}

export function createInMemoryVerdictCache(): AutoVerdictCache {
  const map = new Map<string, AutoVerdictCacheEntry>();
  return {
    get(key) {
      return map.get(cacheKeyString(key));
    },
    set(key, entry) {
      map.set(cacheKeyString(key), entry);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Fallback counters (WS-07 §10.5/§10.6-11): "after 3 consecutive classifier blocks or 20 total,
// auto pauses and falls back to human prompting; any allowed action resets the consecutive count;
// the total persists to threshold; no-verdict/safety-refusal cases do not increment."
// ---------------------------------------------------------------------------------------------
//
// DELIBERATELY no separate "fallbackActive" boolean is persisted: `isFallbackActive` is a pure
// function of the two counters, computed fresh on every check. This is what makes "any allowed
// action resets the consecutive count" ALSO correctly un-trip a purely-consecutive-triggered
// fallback for free (the next check simply recomputes false) while the 20-total trigger stays
// correctly STICKY for the rest of the session (total never decreases -- see auto/engine.ts's own
// header for the reasoning this reading rests on).
export const AUTO_FALLBACK_CONSECUTIVE_THRESHOLD = 3;
export const AUTO_FALLBACK_TOTAL_THRESHOLD = 20;

export interface AutoCounterState {
  consecutive: number;
  total: number;
}

export function isFallbackActive(state: AutoCounterState): boolean {
  return state.consecutive >= AUTO_FALLBACK_CONSECUTIVE_THRESHOLD || state.total >= AUTO_FALLBACK_TOTAL_THRESHOLD;
}

export interface AutoCounterStore {
  get(sessionId: string): AutoCounterState;
  // A genuine classifier "deny" verdict -- increments BOTH counters (WS-07 §10.5).
  recordDeny(sessionId: string): AutoCounterState;
  // A genuine classifier "allow" verdict, OR a human-approved action reached via the fallback
  // prompt path -- resets consecutive, leaves total untouched ("the total persists to threshold").
  recordAllow(sessionId: string): AutoCounterState;
}

const ZERO_STATE: AutoCounterState = { consecutive: 0, total: 0 };

export function createInMemoryAutoCounterStore(): AutoCounterStore {
  const map = new Map<string, AutoCounterState>();
  return {
    get(sessionId) {
      return map.get(sessionId) ?? ZERO_STATE;
    },
    recordDeny(sessionId) {
      const prev = map.get(sessionId) ?? ZERO_STATE;
      const next = { consecutive: prev.consecutive + 1, total: prev.total + 1 };
      map.set(sessionId, next);
      return next;
    },
    recordAllow(sessionId) {
      const prev = map.get(sessionId) ?? ZERO_STATE;
      const next = { consecutive: 0, total: prev.total };
      map.set(sessionId, next);
      return next;
    },
  };
}

// --- File-backed implementation: <sessionId>.auto-state.json, store-adjacent -----------------------
//
// "T11's approvals sidecar machinery ... `<sessionId>.approvals.jsonl`-adjacent or a sibling
// `.auto-state.json` via the same secure-dir/atomic discipline -- your call, flagged." DECISION: a
// sibling `.auto-state.json` (NOT a jsonl append log) -- unlike a durable-approval RECORD (an
// append-only event history with first-response-wins semantics, exactly what jsonl replay is for),
// the counters are a single small mutable value with no history worth keeping; a whole-file
// atomic write (temp file + fsync + rename) is the simpler, equally crash-safe primitive for that
// shape, and avoids an ever-growing replay log for a value that is overwritten on every single
// permission decision. The secure-dir discipline (ensureSecureDir: symlink/ownership/mode checks)
// is mirrored from approvals.ts verbatim -- deliberately duplicated, per that file's OWN header
// precedent ("a THIRD near-identical copy is cheaper than a cross-module coupling neither file
// otherwise needs"); this is the fourth.

export class AutoCounterStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutoCounterStoreError";
  }
}

function assertSafeSegment(value: string, label: string): void {
  if (value === "" || value === "." || value === ".." || value.includes("/")) {
    throw new AutoCounterStoreError(`${label} must be a single, non-empty, non-traversal path segment: ${JSON.stringify(value)}`);
  }
}

function realUid(): number {
  return process.getuid!(); // POSIX-only, Bun-only + macOS-first runtime -- same precedent as approvals.ts/ruleset.ts's own realUid
}

function ensureSecureDir(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (err) {
    if ((err as { code?: unknown }).code !== "EEXIST") throw err;
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new AutoCounterStoreError(`refusing a symlink at a level the auto-counter store must own: ${path}`);
  if (!stat.isDirectory()) throw new AutoCounterStoreError(`expected a directory, found something else at: ${path}`);
  if (stat.uid !== realUid()) throw new AutoCounterStoreError(`refusing a directory owned by a different uid: ${path}`);
  chmodSync(path, 0o700);
}

export interface AutoCounterStoreLocation {
  winterHome: string;
  projectKey: string;
  sessionId: string;
}

function projectDir(location: { winterHome: string; projectKey: string }): string {
  assertSafeSegment(location.projectKey, "projectKey");
  return join(location.winterHome, "projects", location.projectKey);
}

function statePath(location: AutoCounterStoreLocation): string {
  assertSafeSegment(location.sessionId, "sessionId");
  return join(projectDir(location), `${location.sessionId}.auto-state.json`);
}

function ensureDirChain(location: { winterHome: string; projectKey: string }): void {
  const projectsDir = join(location.winterHome, "projects");
  for (const level of [location.winterHome, projectsDir, projectDir(location)]) ensureSecureDir(level);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isValidCount(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0;
}

// Missing file -> zero state (a session that never triggered auto has no sidecar at all) -- ANY
// other read failure (permissions, real I/O error, corrupt JSON) is not swallowed, mirroring
// approvals.ts's own loadExisting posture.
//
// Finding 9 (P2 fix-wave, MINOR; fail-open at P6, production-inert at P2): "corrupt JSON is not
// swallowed" (this function's OWN pre-fix comment) only ever covered a JSON.parse SYNTAX error --
// valid JSON with the WRONG SHAPE (`{}`, `null`, a bare string, a missing/non-numeric field)
// silently loaded as `{consecutive: undefined, total: undefined}`: `isFallbackActive(undefined,
// undefined)` reads false forever (the SS10.5 fallback-to-human brake never engages again), and
// `recordDeny`'s own `prev.consecutive + 1` produces `NaN` from that point on. This is the ONE
// corruption branch in the phase where damage resolves toward PERMISSIVENESS rather than denial --
// every other sidecar in this phase fails closed on a shape it doesn't recognize. Both fields are
// validated as non-negative integers (Number.isFinite + Number.isInteger + >= 0, mirroring
// AutoCounterState's own contract -- a count can never be negative, fractional, or non-finite);
// anything else throws the SAME typed AutoCounterStoreError this function already uses for a real
// I/O error, naming the offending file.
function loadExisting(path: string): AutoCounterState {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return ZERO_STATE;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new AutoCounterStoreError(`malformed JSON in ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isPlainObject(parsed) || !isValidCount(parsed["consecutive"]) || !isValidCount(parsed["total"])) {
    throw new AutoCounterStoreError(`expected an AutoCounterState shape ({consecutive, total} as non-negative integers) in ${path}, got ${JSON.stringify(parsed)}`);
  }
  return { consecutive: parsed["consecutive"] as number, total: parsed["total"] as number };
}

// Whole-file atomic write: write to a uniquely-named sibling temp file (O_CREAT|O_EXCL|O_NOFOLLOW,
// this process's pid+a counter so concurrent writers within the SAME process never collide), fsync
// the temp file's contents, then rename() over the real path -- rename is atomic on the same
// filesystem, so a reader never observes a partially-written state file, and a crash mid-write
// leaves the OLD file intact (never a torn/truncated one).
let tempCounter = 0;
function writeAtomic(path: string, value: AutoCounterState): void {
  const dir = dirname(path);
  const tmpPath = join(dir, `.${process.pid}-${++tempCounter}.auto-state.tmp`);
  const data = Buffer.from(JSON.stringify(value), "utf8");
  const fd = openSync(tmpPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    let written = 0;
    while (written < data.length) written += writeSync(fd, data, written, data.length - written);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, path);
}

export function createFileAutoCounterStore(location: AutoCounterStoreLocation): AutoCounterStore {
  const path = statePath(location);
  let state = loadExisting(path);

  const persist = (): void => {
    ensureDirChain(location);
    writeAtomic(path, state);
  };

  return {
    get() {
      return state;
    },
    recordDeny() {
      state = { consecutive: state.consecutive + 1, total: state.total + 1 };
      persist();
      return state;
    },
    recordAllow() {
      state = { consecutive: 0, total: state.total };
      persist();
      return state;
    },
  };
}
