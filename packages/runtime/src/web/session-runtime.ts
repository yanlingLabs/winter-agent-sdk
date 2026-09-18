// THE SEAM A WEB TOOL'S EXECUTOR REACHES THE SESSION THROUGH.
//
// `WebFetch` and `WebSearch` each run an INNER model pass and one of them needs a credential, and
// `ToolExecutionContext` carries neither a provider nor a credential store. This is the side door:
// a session-keyed registry the engine fills once per run and an executor reads by its own context.
//
// WHY A SESSION-KEYED REGISTRY AND NOT THE ADVISOR'S PATTERN. The advisor's executor is re-installed
// per run with `replaceExecutor`, closing over that run's state. The tool registry is
// PROCESS-GLOBAL and a subagent is another `runEngine()` in the SAME process, so that pattern is
// last-writer-wins: the moment a child engine starts, the parent's advisor calls resolve through the
// child's closures (and keep doing so after the child is gone). For a tool whose closure holds a
// live provider, a usage ledger and a credential resolver, that is the wrong session's model billed
// to the wrong session's ledger. Keyed lookup cannot cross sessions. It is the same mechanism, for
// the same reason, as `toolsearch/search.ts`'s session runtime -- including the identity-checked
// disposer (a resumed child generation registers under the same key while the previous one is still
// tearing down).
//
// WHAT IS PER-RUN AND WHAT IS PER-SESSION. `sessionModel` and `accountUsage` are the RUN's own: a
// child generates on its own provider and spends into its own accountant (which rolls up to its
// parent). `resolveAuxiliaryModel`, `resolveToolSecret` and the host's `web` configuration are the
// SESSION's: they come from the one provider wiring and the one `RuntimeConfig` the root engine was
// started with, which a child's hand-built config does not carry. So a child's runtime INHERITS
// those three from the root's (`inheritedWebSessionFacts`) and supplies the first two itself.
//
// This module registers no tool and imports no executor, so either web tool's impl file (and their
// shared underscore modules) may import it without breaching impl isolation.
import type { CredentialRef, ResolvedWebToolsConfig } from "@yanlinglabs/winter-agent-sdk";
import type { MessageOrigin } from "@yanlinglabs/winter-provider-runtime";
import type { Provider, ProviderUsage } from "../engine.ts";
import type { AuxiliaryModelResolution } from "../provider/session-provider.ts";
import type { ToolSecretResolver } from "../provider/tool-secret.ts";

/** The model a run is generating with RIGHT NOW -- live across `set_model` and a fallback. */
export interface SessionModelHandle {
  provider: Provider;
  /**
   * The session's live model string -- BOTH what an inner request carries as `model` (exactly what
   * the main loop sends, so the adapter translates it identically) AND the key its usage is
   * accounted under (so an inner generation lands on the SAME `modelUsage` row as the main loop's).
   * `undefined` only for a scripted double started with no model string.
   */
  model: string | undefined;
  /** Stamped onto the inner transcript's assistant messages so a real adapter replays them in-domain. */
  origin?: MessageOrigin;
}

export interface WebSessionRuntime {
  /** `RuntimeConfig.web` with every default applied (`resolveWebToolsConfig`). */
  readonly web: ResolvedWebToolsConfig;
  /**
   * THE SESSION'S OWN MODEL, live. The default for every inner pass: always resolvable (the session
   * is already generating on it) and needing no second credential. Read at CALL time, never cached
   * by a consumer -- a `set_model` between two tool calls must move the inner pass with it.
   */
  sessionModel(): SessionModelHandle;
  /**
   * A STATED inner model (`web.fetch.digestModel`), by tag, under the cross-provider credential
   * rule. ABSENT when the session has no catalog identity to resolve against (a scripted double, a
   * session whose own model was refused): a stated tag is then unresolvable, and the consumer says
   * so rather than falling back.
   */
  resolveAuxiliaryModel?: (tag: string, opts?: { authRef?: CredentialRef }) => AuxiliaryModelResolution;
  /**
   * Folds ONE inner generation's usage into this run's accounting, exactly as far as a main-loop
   * generation's goes and no further: it is SPEND (cumulative tokens, the cost ledger, and therefore
   * `maxBudgetUsd`), and it is NOT context -- the inner prompt is never part of the session's next
   * request, so it must not move the context reading compaction triggers on.
   */
  accountUsage(modelKey: string | undefined, usage: ProviderUsage): void;
  /** Resolves a tool's secret from a ref. ABSENT for an engine run with no provider wiring (a bare `runEngine` over a double). */
  resolveToolSecret?: ToolSecretResolver;
}

const sessionRuntimes = new Map<string, WebSessionRuntime>();

/**
 * Registers `runtime` under `key` (`config.agentId ?? config.sessionId` -- a child shares its
 * parent's session id, so the agent id is what tells them apart). Returns an IDENTITY-CHECKED
 * disposer: a late teardown of a previous generation never removes the live one's registration.
 */
export function registerWebSessionRuntime(key: string, runtime: WebSessionRuntime): () => void {
  sessionRuntimes.set(key, runtime);
  return () => {
    if (sessionRuntimes.get(key) === runtime) sessionRuntimes.delete(key);
  };
}

export function getWebSessionRuntime(key: string): WebSessionRuntime | undefined {
  return sessionRuntimes.get(key);
}

/**
 * The runtime for the engine run EXECUTING this tool call: the child's own when the call is a
 * child's, else the session's. Falls back to the owning session's for a child whose own
 * registration is missing, so a wiring gap degrades to "the parent's model" rather than to a tool
 * that cannot run.
 */
export function webSessionRuntimeFor(ctx: { sessionId: string; agentId?: string }): WebSessionRuntime | undefined {
  return (ctx.agentId !== undefined ? sessionRuntimes.get(ctx.agentId) : undefined) ?? sessionRuntimes.get(ctx.sessionId);
}

/** The three SESSION-level facts a child run inherits from the root's registration (see the header). */
export function inheritedWebSessionFacts(sessionId: string): Pick<WebSessionRuntime, "web" | "resolveAuxiliaryModel" | "resolveToolSecret"> | undefined {
  const root = sessionRuntimes.get(sessionId);
  if (root === undefined) return undefined;
  return {
    web: root.web,
    ...(root.resolveAuxiliaryModel !== undefined ? { resolveAuxiliaryModel: root.resolveAuxiliaryModel } : {}),
    ...(root.resolveToolSecret !== undefined ? { resolveToolSecret: root.resolveToolSecret } : {}),
  };
}

/** Test hygiene only: the registry is a process-wide singleton and `bun test` shares one module graph. */
export function resetWebSessionRuntimesForTest(): void {
  sessionRuntimes.clear();
}

// --- The two capability facts ---------------------------------------------------------------------
//
// Pure functions of a runtime, so the engine's capability derivation and a tool's own refusal text
// ask the SAME question and cannot drift.

/** `winter.search-backend`'s session fact: the host has not switched the backend off. */
export function searchBackendUsable(runtime: Pick<WebSessionRuntime, "web">): boolean {
  return runtime.web.search.enabled;
}

/**
 * `winter.fetch-extractor`'s session fact: a digest model resolves.
 *
 * With no `digestModel` stated the digest runs on the session's own model, which resolves by
 * construction. A STATED one must actually resolve -- it is never quietly replaced -- so an
 * unresolvable tag withdraws the tool rather than advertising one that can only refuse. (Whether a
 * CREDENTIAL exists for a cross-provider digest model is not knowable synchronously; that arrives as
 * a typed refusal in the tool's result at the first generation.)
 */
export function digestModelResolves(runtime: Pick<WebSessionRuntime, "web" | "resolveAuxiliaryModel">): boolean {
  const tag = runtime.web.fetch.digestModel;
  if (tag === undefined) return true;
  if (runtime.resolveAuxiliaryModel === undefined) return false;
  try {
    return runtime.resolveAuxiliaryModel(tag, runtime.web.fetch.authRef !== undefined ? { authRef: runtime.web.fetch.authRef } : {}).ok;
  } catch {
    // A resolver that throws is a session with no digest model, never a tool list that throws.
    return false;
  }
}
