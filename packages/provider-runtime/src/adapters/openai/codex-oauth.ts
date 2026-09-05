// `codex-oauth@1` — the Responses API over the ChatGPT Codex backend, on a ChatGPT subscription.
//
// Ported from Norma's `packages/core/src/providers/codex-oauth.ts`. The wire mapping is the
// family's own (`responses.ts`) rather than a second copy — that is the whole point of R6-16's "one
// adapter family per protocol": what makes this a distinct ADAPTER is its credential lifecycle, its
// privileged headers, and the fact that its rate limit is a SUBSCRIPTION state rather than an HTTP
// condition.
//
// Four things worth stating, because each is a rule rather than an implementation detail:
//
//   THE LOGIN FLOW IS HOST-INVOKED. `startCodexLogin(store, { openUrl })` is called by the host, not
//     by a turn. A turn that finds no credential REFUSES with `auth` and says what to run; it never
//     opens a browser on its own behalf, which would be a UI action taken by a library.
//
//   TOKENS LIVE UNDER `codex-oauth:<accountId>`. One Keychain record per provider/account (R6-10),
//     written through the `CredentialStore` — this file never touches `Bun.secrets`, and cannot: the
//     Keychain-backed store is a runtime-side deliverable, deliberately outside this package.
//
//   A 401 REFRESHES EXACTLY ONCE, OUTSIDE THE RETRY BUDGET. It is not a retry — the request was
//     answered, and what changes is the credential, not the timing. `openStream`'s `recover` hook is
//     that door, and it fires once per attempt.
//
//   THE QUOTA MANAGER IS THE ONE PRODUCER OF `rate_limit` (R6-B). An HTTP 429 from this backend is
//     still an `api_retry` with `error_status: 429` like everywhere else; what the quota manager
//     ADDS is the subscription-shaped state the pinned frame actually describes.

import type { WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import type { CredentialMaterial, CredentialRef, CredentialStatus, CredentialStore, DiscoveryContext, ModelCatalogResult, ProviderAdapter, ProviderContext, ProviderEvent, TurnRequest } from "../../types.ts";
import { CODEX, CODEX_MODELS, codexCredentialAccount } from "./codex-config.ts";
import { refreshTokens, runLoginFlow, type OAuthTokens } from "./pkce.ts";
import { QuotaManager, quotaEvent } from "./quota.ts";
import { buildResponsesBody, privilegedHeaders, streamResponsesTurn, type ResponsesTurnPlan } from "./responses.ts";
import {
  EventQueue,
  assertRepresentableTools,
  assertWithinLimits,
  buildHeaders,
  capabilitiesFrom,
  capabilityRefusal,
  errorEvent,
  mapEffortAgainst,
  resolveAuth,
  resolveEndpoint,
  resolveReasoning,
  type OpenAiAdapterOptions,
} from "./shared.ts";

export interface CodexAdapterOptions extends OpenAiAdapterOptions {
  /** The token endpoint. Injectable for a fixture; the production value is `CODEX.tokenUrl`. */
  tokenUrl?: string;
  /** Shared across turns so the subscription state survives one. A fixture may inject its own clock. */
  quota?: QuotaManager;
}

/** How a codex credential is stored: one `oauth` material under `codex-oauth:<accountId>`. */
export function codexCredentialRef(accountId: string, service?: string): Extract<CredentialRef, { kind: "keychain" }> {
  return { kind: "keychain", account: codexCredentialAccount(accountId), ...(service !== undefined ? { service } : {}) };
}

export interface CodexLoginOptions {
  openUrl: (url: string) => Promise<void>;
  /** Overridden by a fixture; production uses `CODEX`'s own values. */
  authorizeUrl?: string;
  tokenUrl?: string;
  callbackPort?: number;
  fallbackCallbackPort?: number;
  timeoutMs?: number;
  /** The Keychain service the record lands in — `config.keychainService` from the host. */
  service?: string;
  onAuthStatus?: (status: { isAuthenticating: boolean; output?: string[]; error?: string }) => void;
}

export interface CodexLoginResult {
  ref: Extract<CredentialRef, { kind: "keychain" }>;
  accountId: string;
  expiresAt: number;
}

/**
 * The host-invoked login. Runs the PKCE loopback flow and PERSISTS the result through the
 * credential store, returning the ref a session should be configured with.
 *
 * An account id is required to name the record: without one there is no per-account slot, and R6-10
 * is explicit that a credential occupies one record per provider/account rather than a shared global
 * slot. A token exchange that returned no id token is therefore a refusal, not a fallback to some
 * default name.
 */
export async function startCodexLogin(store: CredentialStore, options: CodexLoginOptions): Promise<CodexLoginResult> {
  const tokens = await runLoginFlow({
    clientId: CODEX.clientId,
    authorizeUrl: options.authorizeUrl ?? CODEX.authorizeUrl,
    tokenUrl: options.tokenUrl ?? CODEX.tokenUrl,
    callbackPort: options.callbackPort ?? CODEX.callbackPort,
    ...(options.callbackPort === 0 ? {} : { fallbackCallbackPort: options.fallbackCallbackPort ?? CODEX.fallbackCallbackPort }),
    scope: CODEX.scope,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    openUrl: options.openUrl,
    ...(options.onAuthStatus !== undefined ? { onAuthStatus: options.onAuthStatus } : {}),
  });
  if (tokens.accountId === undefined) {
    throw capabilityRefusal("the codex token exchange returned no ChatGPT account id, so the credential has no per-account record to occupy (R6-10)");
  }
  const ref = codexCredentialRef(tokens.accountId, options.service);
  await store.set(ref, materialFor(tokens));
  return { ref, accountId: tokens.accountId, expiresAt: tokens.expiresAt };
}

function materialFor(tokens: OAuthTokens): Extract<CredentialMaterial, { kind: "oauth" }> {
  return {
    kind: "oauth",
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.idToken !== undefined ? { idToken: tokens.idToken } : {}),
    ...(tokens.accountId !== undefined ? { accountId: tokens.accountId } : {}),
    expiresAt: tokens.expiresAt,
  };
}

export function createCodexOauthAdapter(options: CodexAdapterOptions = {}): ProviderAdapter {
  const quota = options.quota ?? new QuotaManager();

  return {
    id: "winter.codex-oauth",
    version: "1",
    family: "openai",
    protocol: "openai-responses",

    async validateCredential(_ref: CredentialRef, ctx: ProviderContext): Promise<CredentialStatus> {
      // Validated LOCALLY rather than by a probe request: this backend has no cheap validation
      // endpoint, and spending a turn's quota to answer "is my login still good" is a real cost to
      // the user. What can be checked without a request is checked.
      const material = await ctx.credentials.get(ctx.authRef);
      if (material === null) return { ok: false, code: "missing", message: "no codex credential is configured — run the host's codex sign-in" };
      if (material.kind !== "oauth") return { ok: false, code: "unsupported", message: `codex-oauth needs an oauth credential, not "${material.kind}"` };
      if (material.expiresAt !== undefined && material.expiresAt <= Date.now() && material.refreshToken === undefined) {
        return { ok: false, code: "expired", message: "the codex credential has expired and carries no refresh token — sign in again" };
      }
      return { ok: true, ...(material.accountId !== undefined ? { accountId: material.accountId } : {}) };
    },

    async listModels(_ctx: DiscoveryContext): Promise<ModelCatalogResult> {
      // A STATIC set, and `partial: false` is the honest value: the backend answers only these slugs
      // for a ChatGPT account, so this is the whole catalog for this credential rather than a page
      // of it. Its date lives in `codex-config.ts` beside the numbers it certifies.
      return {
        models: CODEX_MODELS.map((model) => ({ id: model.id, contextWindow: model.contextWindow, inputModalities: model.supportsVision ? ["text", "image"] : ["text"] })),
        partial: false,
        cached: false,
        warnings: [],
      };
    },

    streamTurn(req: TurnRequest, ctx: ProviderContext): AsyncIterable<ProviderEvent> {
      return codexTurn(req, ctx, options, quota);
    },

    mapEffort(effort: TurnRequest["effort"], model: WinterModelDescriptor) {
      const mapped = mapEffortAgainst(effort, model);
      return mapped.ok ? { ok: true as const, value: mapped.value } : mapped;
    },

    capabilities: capabilitiesFrom,
  };
}

async function* codexTurn(req: TurnRequest, ctx: ProviderContext, options: CodexAdapterOptions, quota: QuotaManager): AsyncIterable<ProviderEvent> {
  const queue = new EventQueue();
  let plan: ResponsesTurnPlan;
  let tokens: Extract<CredentialMaterial, { kind: "oauth" }>;
  try {
    const descriptor = options.descriptors?.(req.model);
    assertRepresentableTools(req.tools);
    const reasoning = resolveReasoning(req, descriptor);
    assertWithinLimits(req, descriptor, [
      ...(reasoning.effort !== undefined ? ["reasoning", "reasoning.effort"] : []),
      ...(reasoning.summary !== undefined ? ["reasoning.summary"] : []),
      ...(req.maxOutputTokens !== undefined ? ["max_output_tokens"] : []),
    ]);
    const endpoint = resolveEndpoint(ctx, options, CODEX.backendUrl);
    const auth = await resolveAuth(ctx, "bearer");
    if (auth.material === null) throw new CodexAuthRefusal("not signed in to a ChatGPT account — run the host's codex sign-in");
    if (auth.material.kind !== "oauth") throw new CodexAuthRefusal(`codex-oauth needs an oauth credential, not "${auth.material.kind}"`);
    tokens = auth.material;
    plan = {
      url: `${endpoint.baseUrl}/responses`,
      headers: codexHeaders(endpoint.policy, tokens, ctx, options),
      endpoint,
      ctx,
      options,
      body: JSON.stringify(buildResponsesBody(req, reasoning, descriptor)),
      queue,
      beforeAttempt: async () => {
        // A known subscription window is waited out BEFORE the request rather than discovered by
        // being refused again — which is the whole value of tracking the state at all.
        await quota.waitIfLimited(req.signal);
      },
      recover: async (status) => {
        if (status !== 401 || tokens.refreshToken === undefined) return undefined;
        queue.push({ type: "auth_status", isAuthenticating: true, output: ["refreshing the codex token"] });
        try {
          const fresh = await refreshTokens(options.tokenUrl ?? CODEX.tokenUrl, CODEX.clientId, tokens.refreshToken);
          // A refresh grant usually returns no id token and may not rotate the refresh token, so a
          // missing field must NEVER clobber a known-good one (the port's own finding).
          tokens = {
            ...tokens,
            accessToken: fresh.accessToken,
            expiresAt: fresh.expiresAt,
            ...(fresh.refreshToken !== undefined ? { refreshToken: fresh.refreshToken } : {}),
            ...(fresh.idToken !== undefined ? { idToken: fresh.idToken } : {}),
            ...(fresh.accountId !== undefined ? { accountId: fresh.accountId } : {}),
          };
          if (ctx.authRef.kind === "keychain") await ctx.credentials.set(ctx.authRef, tokens);
          queue.push({ type: "auth_status", isAuthenticating: false, output: ["codex token refreshed"] });
          return codexHeaders(endpoint.policy, tokens, ctx, options);
        } catch (err) {
          queue.push({ type: "auth_status", isAuthenticating: false, error: err instanceof Error ? err.message : String(err) });
          return undefined;
        }
      },
      onRateLimited: (retry, q) => {
        // R6-B: the retry itself is the pinned 429 path. What this ADDS is the subscription state,
        // which is the only thing `rate_limit` is allowed to describe.
        //
        // `retry.retryDelayMs` IS the window: `RetryPolicy.delayMs` returns the `Retry-After` the
        // backend sent (clamped at 60 s) when it sent one, and the jittered backoff otherwise.
        // Passing `undefined` here instead recorded a ZERO-length window — `limitedUntil = now`, so
        // `state()` read `ok` on the very next line and the event went out saying `status:
        // "allowed"` ON A RATE LIMIT, with the recovery event never firing either because
        // `wasLimited` was never true. A test asserting only `kind === "subscription-quota"` passes
        // either way, which is why the assertions below it now read `info.status`.
        quota.noteRateLimit(retry.retryDelayMs);
        q.push(quotaEvent(quota.state()));
      },
      onSuccess: () => {
        const wasLimited = quota.state().kind === "limited";
        quota.noteRecovered();
        if (wasLimited) queue.push(quotaEvent({ kind: "ok" }));
      },
    };
  } catch (err) {
    yield errorEvent(err);
    return;
  }

  await quota.acquire();
  try {
    for await (const event of streamResponsesTurn(plan, req.signal)) {
      if (event.type === "usage") quota.accumulate(event.inputTokens, event.outputTokens);
      yield event;
    }
  } finally {
    quota.release();
  }
}

/** A codex auth refusal, shaped so `normalizeThrown` classifies it as `auth` rather than a bare network error. */
class CodexAuthRefusal extends Error {
  readonly code = "auth" as const;
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = "CodexAuthRefusal";
  }
}

/**
 * The codex request headers.
 *
 * `OpenAI-Beta` is PROTOCOL (the surface cannot be spoken to without it). `originator` and
 * `chatgpt-account-id` are PRIVILEGED (R6-L): the first identifies this client to the reviewed
 * backend and the second names the operator's ChatGPT account, and neither has any business at a
 * base URL the reviewed catalog never named.
 */
function codexHeaders(policy: ResponsesTurnPlan["endpoint"]["policy"], tokens: Extract<CredentialMaterial, { kind: "oauth" }>, ctx: ProviderContext, options: CodexAdapterOptions): Record<string, string> {
  return buildHeaders({
    policy,
    protocol: { "content-type": "application/json", accept: "text/event-stream", "OpenAI-Beta": CODEX.headers["OpenAI-Beta"]!, authorization: `Bearer ${tokens.accessToken}` },
    privileged: { ...privilegedHeaders(options), originator: CODEX.headers.originator!, ...(tokens.accountId !== undefined ? { "chatgpt-account-id": tokens.accountId } : {}) },
    userSupplied: ctx.connection.headers,
  });
}
