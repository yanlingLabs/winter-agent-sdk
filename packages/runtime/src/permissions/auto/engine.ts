// Task 12 (WS-07 §6.6/§10): the real AutoEngine seam fill — evaluator.ts's T6 stub
// (NO_OPINION_AUTO_ENGINE) always answered "no_verdict"; this is the concrete pipeline behind
// `ctx.autoEngine.classify()` (§10.1 steps 5-8: classifier consultation, cache, counters,
// fallback). Steps 1-4 (deny/ask, broad-allow suspension, surviving narrow allow, read-only/
// in-cwd-edit skip) are NOT this file's job — they already run inside evaluator.ts's own pipeline
// BEFORE this seam is ever consulted (see that file's own auto-mode comments for exactly where).
//
// Ruling P2 (phase ruling 5, restated by the controller dispatch): MECHANICS, not policy. The ONLY
// classifier this file ships is `alwaysNoVerdictClassifier` — a deliberate, permanent fail-closed
// stub. The real model-routed classifier is P6/D13's job (WS-07 §10.6-4).
import type { PermissionCall, EvaluationContext, AutoEngine, AutoEngineVerdict } from "../evaluator.ts";
// Re-exported (not re-defined) — evaluator.ts is the canonical, single source of truth for this
// exact string (it is what evaluate() itself attaches to every classifier-driven denial); kept
// importable from here too so a consumer of the auto/ package never needs to reach into
// evaluator.ts just for this one constant.
export { BLOCKED_BY_CLASSIFIER_MESSAGE } from "../evaluator.ts";
import { buildActionEnvelope, type ActionEnvelope } from "./envelope.ts";
import { normalizeAutoModeConfig, resolveAutoTier, type NormalizedAutoModeConfig } from "./config.ts";
import {
  computePolicyHash,
  computeEnvHash,
  computeActionFingerprint,
  createInMemoryVerdictCache,
  createInMemoryAutoCounterStore,
  isFallbackActive,
  type AutoVerdictCache,
  type AutoVerdictCacheKey,
  type AutoCounterStore,
} from "./caches.ts";
import type { AttributedContext } from "../../hooks/reducer.ts";

// ---------------------------------------------------------------------------------------------
// ClassifierInterface (WS-07 §10.6-3/§10.6-4/§10.6-5) — the ONE reviewer the real AutoEngine
// consults. Strict result schema; extra/unparseable output, timeout, refusal, transport failure
// are all the SAME "no_verdict" from this interface's own caller's point of view — a real (P6)
// classifier implementation is responsible for collapsing all of those failure shapes into
// "no_verdict" itself before returning, exactly like alwaysNoVerdictClassifier below does trivially.
// ---------------------------------------------------------------------------------------------

export interface ClassifierRawResult {
  verdict: "allow" | "deny" | "no_verdict";
  category?: string;
  severity?: string;
  reasonCode?: string;
  auditReason?: string;
}

// The bounded context (WS-07 §10.4/§10.6-8) the classifier sees. `autoConfig` is the one thing P2
// can populate for real (the effective, normalized autoMode rules); `classifierContext` is T9's
// PostToolUse-accumulated field, attributed. Conversation-history/WINTER.md/repository fields are
// P3/P4 placeholders — no such plumbing reaches the permission evaluator at P2 (evaluator.ts
// operates purely on `ctx` + one `call`, never message history).
export interface ClassifierContext {
  autoConfig: NormalizedAutoModeConfig;
  classifierContext: AttributedContext[];
  recentUserMessages?: string[];
  winterMdContent?: string;
  repository?: { remotes: string[] };
  gitStatusSummary?: string;
}

export interface ClassifierInterface {
  classify(envelope: ActionEnvelope, context: ClassifierContext): Promise<ClassifierRawResult>;
}

// P2's ENTIRE production classifier (Phase ruling 5 / WS-07 §10.6-4): fail-closed, permanent,
// never consults `envelope`/`context` at all. The real model-routed classifier is P6/D13's job.
export const alwaysNoVerdictClassifier: ClassifierInterface = {
  async classify(): Promise<ClassifierRawResult> {
    return { verdict: "no_verdict", reasonCode: "p2_no_real_classifier" };
  },
};

// A test double letting fixtures script exact verdicts (a fixed result, a per-call array, or a
// full predicate function) and inspect what the engine actually sent it — needed for counter/
// cache/fallback/tier fixtures that a permanently-no_verdict classifier could never exercise.
export interface ScriptedClassifier extends ClassifierInterface {
  readonly calls: ReadonlyArray<{ envelope: ActionEnvelope; context: ClassifierContext }>;
}

export function createScriptedClassifier(
  script: ClassifierRawResult | ClassifierRawResult[] | ((envelope: ActionEnvelope, context: ClassifierContext) => ClassifierRawResult | Promise<ClassifierRawResult>),
): ScriptedClassifier {
  const calls: Array<{ envelope: ActionEnvelope; context: ClassifierContext }> = [];
  let callIndex = 0;
  return {
    calls,
    async classify(envelope, context) {
      calls.push({ envelope, context });
      if (typeof script === "function") return script(envelope, context);
      if (Array.isArray(script)) {
        const result = script[Math.min(callIndex, script.length - 1)]!;
        callIndex++;
        return result;
      }
      return script;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Audit seam (WS-07 §10.6-12): permission_evaluated / classifier_started / classifier_result /
// classifier_cache_hit / permission_denied / fallback_state. Mirrors HookAuditRecorder's OWN
// "auxiliary, never fails the decision it accompanies" pattern (hooks/runner.ts) rather than
// reusing that exact type — these are PERMISSION events (hookId/hookEvent make no sense here), not
// hook events. Public-stream projection is explicitly NOT this task's job (WS-15's projector
// work); this is the same private-audit-journal shape class as the hook audit journal.
// ---------------------------------------------------------------------------------------------

export type AutoAuditEventType = "permission_evaluated" | "classifier_started" | "classifier_result" | "classifier_cache_hit" | "permission_denied" | "fallback_state";

export interface AutoAuditRecord {
  type: AutoAuditEventType;
  sessionId: string;
  at: string; // ISO 8601
  toolName: string;
  toolUseId?: string;
  agentId?: string;
  verdict?: "allow" | "deny" | "no_verdict";
  category?: string;
  severity?: string;
  reasonCode?: string;
  // Redacted (see redactAuditReason below) BEFORE it ever reaches this record — WS-07 §10.6-5:
  // "detailed reasoning goes to the audit stream after secret/path redaction."
  auditReason?: string;
  fallbackActive?: boolean;
  consecutive?: number;
  total?: number;
  // Fix round 1 (§10.6-12, VERBATIM: "policy/version/model/latency fields"). `policyVersion`/
  // `policyHash` are REQUIRED, not optional — every classify() call has `ctx.policy` in hand, and
  // both are computed exactly ONCE per call and reused for every record it emits (see classify()'s
  // own hoisted `policyVersion`/`policyHash` consts — the cache-key site reuses the same
  // `policyHash` too, never a second computePolicyHash call). `latencyMs` is likewise always
  // measurable (Date.now() at classify() entry vs. at record time) — the SAME precedent as
  // hooks/runner.ts's own `durationMs` (ruleset.ts:667's HookAuditJournalRecord mirrors it too).
  policyVersion: number;
  policyHash: string;
  latencyMs: number;
  // `model` is typed-optional and UNPOPULATED at P2 — no classifier ships a model identity until
  // the real model-routed classifier lands (P6/D13, WS-07 §10.6-4); alwaysNoVerdictClassifier and
  // ScriptedClassifier both have no such concept to report. Field exists now so a P6 producer needs
  // no interface change — the SAME field-exists-unpopulated discipline envelope.ts's own
  // provenance/networkDestinations already use.
  model?: string;
}

export interface AutoAuditRecorder {
  record(entry: AutoAuditRecord): void | Promise<void>;
}

export const NO_OP_AUTO_AUDIT_RECORDER: AutoAuditRecorder = {
  record() {
    /* no-op */
  },
};

// Minimal, documented placeholder (WS-07 §10.6-5's own redaction obligation) — NOT a general
// secret scanner (that is a much larger, separately-scoped effort; WS-15/P6 territory). This
// strips the two absolute paths this evaluator already knows are sensitive (the session's cwd and
// the real user home) out of whatever prose a classifier returned, so an obvious "the reviewer
// quoted my home directory back into a private audit log" leak is at least closed at the one
// class of path this function can name with confidence. Unexercised in production at P2 (the
// ONLY shipped classifier, alwaysNoVerdictClassifier, never sets auditReason at all).
export function redactAuditReason(reason: string | undefined, ctx: { cwd: string; home: string }): string | undefined {
  if (reason === undefined) return undefined;
  let out = reason;
  if (ctx.home.length > 0) out = out.split(ctx.home).join("<redacted-home>");
  if (ctx.cwd.length > 0) out = out.split(ctx.cwd).join("<redacted-cwd>");
  return out;
}

// ---------------------------------------------------------------------------------------------
// createAutoEngine — the concrete AutoEngine (evaluator.ts's seam interface)
// ---------------------------------------------------------------------------------------------

export interface AutoEngineOptions {
  // Session-scoped closure state (the SAME shape createHookStage already establishes elsewhere in
  // this codebase for its own session-scoped seam) — EvaluationContext itself carries no
  // sessionId (see envelope.ts's own header for why), so the concrete engine closes over it here
  // rather than evaluator.ts threading a new field through every call.
  sessionId: string;
  runtimeKind?: string;
  classifier?: ClassifierInterface; // defaults to alwaysNoVerdictClassifier -- P2's only real option
  counters?: AutoCounterStore; // defaults to an in-memory store
  cache?: AutoVerdictCache; // defaults to an in-memory cache
  audit?: AutoAuditRecorder; // defaults to NO_OP_AUTO_AUDIT_RECORDER
  // T9's PostToolUse-accumulated classifierContext (WS-07 §10.4/§10.6-8) -- a closure the caller
  // (engine.ts) supplies over whatever running accumulator it maintains for the session. Absent
  // (or omitted) reads as "nothing accumulated yet," never a fabricated entry.
  getClassifierContext?: () => AttributedContext[];
  // "new content/turn/compaction" generation counter (WS-07 §10.5's cache-invalidation axis) -- no
  // turn/compaction-counter concept reaches this file at P2; a caller with no such signal yet may
  // omit this entirely (defaults to a constant `0`, documented at this one call site).
  getGeneration?: () => number;
}

export function createAutoEngine(options: AutoEngineOptions): AutoEngine {
  const classifier = options.classifier ?? alwaysNoVerdictClassifier;
  const counters = options.counters ?? createInMemoryAutoCounterStore();
  const cache = options.cache ?? createInMemoryVerdictCache();
  const audit = options.audit ?? NO_OP_AUTO_AUDIT_RECORDER;

  async function recordAudit(entry: AutoAuditRecord): Promise<void> {
    try {
      await audit.record(entry);
    } catch {
      /* auxiliary -- never fails the permission decision it accompanies (mirrors HookAuditRecorder's own posture) */
    }
  }

  return {
    async classify(call: PermissionCall, ctx: EvaluationContext): Promise<AutoEngineVerdict> {
      const startedAtMs = Date.now();
      const startedAt = new Date(startedAtMs).toISOString();
      // Fix round 1 (§10.6-12, VERBATIM: "policy/version/model/latency fields"): computed ONCE,
      // here, and reused by EVERY record this call emits below — never recomputed per event (the
      // cache-key site further down reuses this same `policyHash`, it does not call
      // computePolicyHash a second time). `ctx.policy` is a fixed snapshot for the lifetime of one
      // classify() call, mirroring evaluate()'s own "stamped once, at evaluation start" discipline
      // for policyVersion.
      const policyVersion = ctx.policy.version;
      const policyHash = computePolicyHash(ctx.policy);
      // Fix round 1: stamped on EVERY record below (not just permission_evaluated), so a consumer
      // can correlate classifier_started/classifier_result/etc. back to their originating call
      // without relying on emission order alone.
      const callIdentity = {
        ...(call.toolUseId !== undefined ? { toolUseId: call.toolUseId } : {}),
        ...(call.agentId !== undefined ? { agentId: call.agentId } : {}),
      };

      await recordAudit({
        type: "permission_evaluated",
        sessionId: options.sessionId,
        at: startedAt,
        toolName: call.toolName,
        policyVersion,
        policyHash,
        latencyMs: Date.now() - startedAtMs,
        ...callIdentity,
      });

      // WS-07 §10.5/§10.6-11: fallback check runs BEFORE any classifier consultation at all --
      // "auto pauses" means the classifier is never even called while tripped. Signaled back to
      // evaluate() via `fallbackToPrompt` rather than this file reaching into ctx.promptStage
      // itself -- evaluate() already owns every promptStage.prompt() call site (PermissionRequest
      // hook precedence, meta-building); duplicating that orchestration here would risk drifting
      // out of sync with it.
      const counterState = counters.get(options.sessionId);
      if (isFallbackActive(counterState)) {
        await recordAudit({
          type: "fallback_state",
          sessionId: options.sessionId,
          at: startedAt,
          toolName: call.toolName,
          policyVersion,
          policyHash,
          latencyMs: Date.now() - startedAtMs,
          fallbackActive: true,
          consecutive: counterState.consecutive,
          total: counterState.total,
          ...callIdentity,
        });
        return { verdict: "no_verdict", category: "fallback", reasonCode: "auto_fallback_active", fallbackToPrompt: true };
      }

      const normalizedConfig = normalizeAutoModeConfig(ctx.policy.autoConfig);
      const envelope = buildActionEnvelope(call, ctx, {
        sessionId: options.sessionId,
        ...(options.runtimeKind !== undefined ? { runtimeKind: options.runtimeKind } : {}),
        classifierContext: options.getClassifierContext?.() ?? [],
      });
      const classifierContext: ClassifierContext = { autoConfig: normalizedConfig, classifierContext: envelope.classifierContext };

      const cacheKey: AutoVerdictCacheKey = {
        policyHash,
        envHash: computeEnvHash(ctx),
        sessionId: options.sessionId,
        generation: options.getGeneration?.() ?? 0,
        actionFingerprint: computeActionFingerprint(call),
        ...(envelope.networkDestinations?.[0] !== undefined ? { host: envelope.networkDestinations[0] } : {}),
      };
      const cached = cache.get(cacheKey);
      if (cached !== undefined) {
        await recordAudit({
          type: "classifier_cache_hit",
          sessionId: options.sessionId,
          at: new Date().toISOString(),
          toolName: call.toolName,
          policyVersion,
          policyHash,
          latencyMs: Date.now() - startedAtMs,
          verdict: cached.verdict.verdict,
          ...(cached.verdict.category !== undefined ? { category: cached.verdict.category } : {}),
          ...callIdentity,
        });
        // Fix round 1: a cache hit is STILL a genuine denial-as-tool_result outcome for THIS call
        // -- evaluate() treats a cached verdict identically to a freshly-computed one
        // (resolveAutoDecision, evaluator.ts) -- so a consumer watching for `permission_denied`
        // alone must see it here too, not only on the classifier-consulted path below.
        if (cached.verdict.verdict !== "allow") {
          await recordAudit({
            type: "permission_denied",
            sessionId: options.sessionId,
            at: new Date().toISOString(),
            toolName: call.toolName,
            policyVersion,
            policyHash,
            latencyMs: Date.now() - startedAtMs,
            verdict: cached.verdict.verdict,
            ...(cached.verdict.category !== undefined ? { category: cached.verdict.category } : {}),
            ...(cached.verdict.reasonCode !== undefined ? { reasonCode: cached.verdict.reasonCode } : {}),
            ...callIdentity,
          });
        }
        return cached.verdict; // a cache hit replays a PRIOR decision -- never touches the counters again
      }

      await recordAudit({
        type: "classifier_started",
        sessionId: options.sessionId,
        at: new Date().toISOString(),
        toolName: call.toolName,
        policyVersion,
        policyHash,
        latencyMs: Date.now() - startedAtMs,
        ...callIdentity,
      });
      const raw = await classifier.classify(envelope, classifierContext);
      const redactedReason = redactAuditReason(raw.auditReason, { cwd: ctx.cwd, home: ctx.home });
      await recordAudit({
        type: "classifier_result",
        sessionId: options.sessionId,
        at: new Date().toISOString(),
        toolName: call.toolName,
        policyVersion,
        policyHash,
        latencyMs: Date.now() - startedAtMs,
        verdict: raw.verdict,
        ...(raw.category !== undefined ? { category: raw.category } : {}),
        ...(raw.severity !== undefined ? { severity: raw.severity } : {}),
        ...(raw.reasonCode !== undefined ? { reasonCode: raw.reasonCode } : {}),
        ...(redactedReason !== undefined ? { auditReason: redactedReason } : {}),
        ...callIdentity,
      });

      // Tier backstop (WS-07 §10.2/§10.6-7, defense in depth): a hard_deny/uncleared-soft_deny
      // category FORCES deny regardless of the raw classifier verdict -- this can only make an
      // outcome STRICTER, never more permissive than what the classifier itself said.
      const tier = resolveAutoTier(raw.category, normalizedConfig);
      const verdict: AutoEngineVerdict["verdict"] = tier === "hard_denied" || tier === "soft_denied" ? "deny" : raw.verdict;

      // WS-07 §10.5: only a GENUINE classifier deny/allow moves the counters; no_verdict (timeout/
      // malformed/refusal/transport-failure, all already collapsed into "no_verdict" by the
      // classifier itself) never does.
      if (verdict === "deny") counters.recordDeny(options.sessionId);
      else if (verdict === "allow") counters.recordAllow(options.sessionId);

      const result: AutoEngineVerdict = {
        verdict,
        ...(raw.category !== undefined ? { category: raw.category } : {}),
        ...(raw.reasonCode !== undefined ? { reasonCode: raw.reasonCode } : {}),
      };
      // §10.5: "no-verdict... denials have their own cache until new content or compaction" --
      // cached alongside allow/deny (the cache key's own generation component is exactly that
      // "until new content" boundary).
      cache.set(cacheKey, { verdict: result, cachedAt: new Date().toISOString() });

      // Fix round 1 (§10.6-12): the auto arm's own denial-as-tool_result outcome — evaluate()'s
      // resolveAutoDecision (evaluator.ts) maps any non-"allow" verdict straight to a denied
      // tool_result carrying the stable BLOCKED_BY_CLASSIFIER_MESSAGE string, never a prompt. This
      // is the ONE first-class event a consumer can watch for "was this call denied" without also
      // having to inspect classifier_result/classifier_cache_hit's own `verdict` sub-field.
      if (verdict !== "allow") {
        await recordAudit({
          type: "permission_denied",
          sessionId: options.sessionId,
          at: new Date().toISOString(),
          toolName: call.toolName,
          policyVersion,
          policyHash,
          latencyMs: Date.now() - startedAtMs,
          verdict,
          ...(raw.category !== undefined ? { category: raw.category } : {}),
          ...(raw.reasonCode !== undefined ? { reasonCode: raw.reasonCode } : {}),
          ...callIdentity,
        });
      }
      return result;
    },

    // WS-07 §10.5: "any allowed action resets the consecutive count." The ONLY way the
    // 3-consecutive cooldown (deliberately NOT sticky, unlike the 20-total ceiling — see
    // caches.ts's own header) can un-trip: evaluate() calls this after a fallback-routed
    // hook/canUseTool decision resolves. A "deny" outcome (including "nobody answered") does
    // nothing on purpose -- it is not a classifier verdict and must not perturb counters that
    // exist to count THOSE.
    noteFallbackResolution(outcome: "allow" | "deny"): void {
      if (outcome === "allow") counters.recordAllow(options.sessionId);
    },
  };
}
