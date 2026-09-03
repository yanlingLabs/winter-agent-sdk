// Task 12 (WS-07 §10.6-1): buildActionEnvelope — the normalized action envelope every auto-mode
// decision consumes "never a tool name alone." P2-fillable fields are populated for real; P3+
// fields are typed optional with an owner comment, never fabricated.
import { realpathSync } from "node:fs";
import { dirname, basename, join, resolve } from "node:path";
import type { PermissionCall, EvaluationContext } from "../evaluator.ts";
import { boundedRoots, extractCandidateWritePaths } from "../evaluator.ts";
import { splitCompound, extractRedirectTargets } from "../grammar.ts";
import type { AttributedContext } from "../../hooks/reducer.ts";

// ---------------------------------------------------------------------------------------------
// Best-effort symlink-target resolution for envelope/audit purposes ONLY. NOT a security check —
// T4's paths.ts (matchFileRuleAtBothEnds/checkSymlinkBothEnds) already performed the REAL
// enforcement upstream, before evaluate() ever reaches the auto engine. This is envelope
// TELEMETRY: best-effort, tolerant of any resolution failure (a symlink loop, a permission error,
// an exotic fs), falling back to "no symlink, target == path" rather than throwing and aborting
// the whole permission decision over a cosmetic field. paths.ts keeps its own resolver PRIVATE
// (this task's edit authorization does not extend to widening its exports); duplicating just the
// ENOENT-climbing walk mirrors approvals.ts's own precedent for exactly this trade-off.
// ---------------------------------------------------------------------------------------------
function resolveRealTargetBestEffort(path: string): string {
  try {
    return realpathSync(path);
  } catch (err) {
    if ((err as { code?: unknown }).code !== "ENOENT") return path; // best-effort: never throw out of envelope building
    const dir = dirname(path);
    if (dir === path) return path;
    try {
      return join(resolveRealTargetBestEffort(dir), basename(path));
    } catch {
      return path;
    }
  }
}

export interface ResolvedEnvelopePath {
  path: string;
  resolvedTarget: string;
  isSymlink: boolean;
}

function resolveCandidatePaths(call: PermissionCall, ctx: EvaluationContext): ResolvedEnvelopePath[] {
  const raw: string[] = [];
  if (call.toolName === "Read" && typeof call.input["file_path"] === "string") raw.push(call.input["file_path"] as string);
  raw.push(...extractCandidateWritePaths(call, ctx));
  const seen = new Set<string>();
  const out: ResolvedEnvelopePath[] = [];
  for (const p of raw) {
    const absPath = resolve(ctx.cwd, p);
    if (seen.has(absPath)) continue;
    seen.add(absPath);
    const resolvedTarget = resolveRealTargetBestEffort(absPath);
    out.push({ path: absPath, resolvedTarget, isSymlink: resolvedTarget !== absPath });
  }
  return out;
}

function shellDecomposition(call: PermissionCall): { subcommands?: string[]; redirectTargets?: string[] } {
  if (call.toolName !== "Bash") return {};
  const raw = call.input["command"];
  if (typeof raw !== "string") return {};
  const parts = splitCompound(raw); // T3 helper — null on unparseable/over-limit input (grammar.ts's own documented escape)
  const redirectTargets = extractRedirectTargets(raw);
  return {
    ...(parts !== null ? { subcommands: parts } : {}),
    ...(redirectTargets.length > 0 ? { redirectTargets } : {}),
  };
}

// §10.4/§10.6-8: "Untrusted content goes to the worker; provenance/suspicion metadata goes to the
// reviewer — the worker never authors that trusted field." No incoming-content probe exists
// anywhere in this codebase at P2 (the report's own words: "a separate probe MAY flag suspicious
// incoming content" — never built here). Left entirely ABSENT (never a fabricated fixed literal)
// rather than guessing a value nothing has actually computed — a future probe populates this
// without a shape change (the field already exists, typed optional).
export interface ActionProvenance {
  suspicious?: boolean;
  source?: string;
}

export interface ActionBoundaries {
  protectedWrite: boolean;
  criticalRemoval: boolean;
  criticalReason?: string;
}

export interface ActionEnvelope {
  // --- identity — P2-available subset; the richer set is threaded in via `extras` because
  // EvaluationContext itself carries none of it (no sessionId/turn concept reaches the pure
  // evaluator — see evaluator.ts's own EvaluationContext, and this file's buildActionEnvelope
  // `extras` parameter). ---
  toolUseId?: string;
  agentId?: string;
  sessionId?: string;
  runtimeKind?: string;
  // Never produced anywhere at P2 — no turn-counter/conversation-generation concept exists yet
  // (caches.ts's own `generation` key component is caller-supplied, constant `0`, for the same
  // reason). P3/P4 owner.
  turnId?: string;

  // --- tool + input ---
  toolName: string;
  canonicalToolName: string; // no alias table exists yet (WS-06, P3) — canonical === raw at P2
  input: Record<string, unknown>;

  // --- filesystem context ---
  cwd: string;
  roots: string[]; // boundedRoots(ctx): cwd + rule-derived + additionalDirectories
  resolvedPaths: ResolvedEnvelopePath[];

  // --- shell decomposition (T3 helpers) — Bash only; absent for every other tool ---
  shellSubcommands?: string[];
  shellRedirectTargets?: string[];

  // --- provenance / suspicion (§10.4) — see ActionProvenance's own header; absent at P2 ---
  provenance?: ActionProvenance;

  // --- boundaries — P2-fillable via ctx.specialChecks (T7's seam), reused rather than re-derived ---
  boundaries: ActionBoundaries;

  // --- session-created-resources — WS-07 §10.6-1 names this explicitly as a "placeholder"; no
  // session-created-resource tracking (temp files/branches/etc. this run itself created) exists
  // anywhere yet. Always empty at P2; typed as a real array (not optional) because the FIELD's
  // existence, not its population, is what §10.6-1 asks P2 to guarantee.
  sessionCreatedResources: string[];

  // --- P3+/P4 placeholders — no network/repository introspection reaches the permission
  // evaluator at P2 (WS-12 sandbox composition and repo/remote tracking are separate, later work) ---
  networkDestinations?: string[];
  repository?: { remotes: string[] };

  // --- classifier-context contribution (§10.4/§10.6-8: PostToolUse hooks' T9-accumulated field,
  // "flow in attributed") — always present as an array (possibly empty), never fabricated content.
  classifierContext: AttributedContext[];
}

export interface BuildActionEnvelopeExtras {
  sessionId?: string;
  runtimeKind?: string;
  classifierContext?: AttributedContext[];
}

export function buildActionEnvelope(call: PermissionCall, ctx: EvaluationContext, extras?: BuildActionEnvelopeExtras): ActionEnvelope {
  const boundaries: ActionBoundaries = {
    protectedWrite: ctx.specialChecks.isProtectedWrite(call, ctx),
    criticalRemoval: ctx.specialChecks.isCriticalRemoval(call, ctx).critical,
  };
  const criticalReason = ctx.specialChecks.isCriticalRemoval(call, ctx).reason;
  const decomposition = shellDecomposition(call);

  return {
    ...(call.toolUseId !== undefined ? { toolUseId: call.toolUseId } : {}),
    ...(call.agentId !== undefined ? { agentId: call.agentId } : {}),
    ...(extras?.sessionId !== undefined ? { sessionId: extras.sessionId } : {}),
    ...(extras?.runtimeKind !== undefined ? { runtimeKind: extras.runtimeKind } : {}),
    toolName: call.toolName,
    canonicalToolName: call.toolName,
    input: call.input,
    cwd: ctx.cwd,
    roots: boundedRoots(ctx),
    resolvedPaths: resolveCandidatePaths(call, ctx),
    ...(decomposition.subcommands !== undefined ? { shellSubcommands: decomposition.subcommands } : {}),
    ...(decomposition.redirectTargets !== undefined ? { shellRedirectTargets: decomposition.redirectTargets } : {}),
    boundaries: { ...boundaries, ...(criticalReason !== undefined ? { criticalReason } : {}) },
    sessionCreatedResources: [],
    classifierContext: extras?.classifierContext ?? [],
  };
}
