# P6 derived shapes — provider layer, streaming, retries, models, cost, continuity (pinned 0.3.250)

Authority for every Phase-6 (WS-13) task's field-level shapes: T1 of the 2026-09-05 plan. Mirrors
`derived-shapes-p2.md` / `-p3.md` / `-p3-task8.md` / `-p4.md` / `-p5.md`'s method and citation
discipline in this same directory. Nothing here re-derives a prior file's finding; where a P4/P5
shape is load-bearing for a P6 item it is cited by reference rather than re-derived.

Like P5, this file carries **hermetic runtime captures** alongside the declaration facts. Every
capture is report-only: no golden was written, no fixture was committed, nothing from the artifact
persists past this document's names, numbers and field shapes.

## The headline finding, stated first because it reshapes items (a), (e) and (f)

**The pinned artifact does not declare a single Anthropic wire content-block or stream-event shape.**
Every one of them is a *type import from a floating peer dependency*:

- `sdk.d.ts:1` — `BetaMessage` from `@anthropic-ai/sdk`
- `sdk.d.ts:2` — `BetaRawMessageStreamEvent` from `@anthropic-ai/sdk`
- `sdk.d.ts:3` — `BetaUsage` from `@anthropic-ai/sdk`
- `sdk.d.ts:8` — `MessageParam` from `@anthropic-ai/sdk`
- `package.json` `peerDependencies`: `"@anthropic-ai/sdk": ">=0.93.0"` — an **open lower bound**, not
  a pin. `checksums.json` in this directory covers the wrapper tarball only; the peer's declaration
  is outside everything this repository verifies.

Consequences a Phase-6 lane must not paper over:

1. The `stream_event` `event` union's **member names** exist in the pin only as a six-name JSDoc list
   (`sdk.d.ts:4547`); **no payload field of any member is declared anywhere in the pin**.
2. `NonNullableUsage` (`sdk.d.ts:1325-1327`) is `{[K in keyof BetaUsage]: NonNullable<BetaUsage[K]>}`
   — a mapped type over an unpinned external type. The pin fixes the *non-nullability rule*, not the
   *field set*.
3. **Item (f)'s entire subject** — `thinking.signature`, `redacted_thinking`, `image.source`,
   `tool_result.content` — is not declared in the pin at all. R6-8's parenthetical ("assuming it
   does; Anthropic's `ThinkingBlock` does") is an assumption **the pinned artifact cannot confirm or
   deny**. Item (f) below therefore answers the question from the *runtime*, not the declaration.

This is itself a P6 finding: Winter's own SDK surface must decide whether to re-export a floating
peer's types (inheriting its drift) or declare its own — recorded as OQ-P6-1.

## Method

The pinned `@anthropic-ai/claude-agent-sdk@0.3.250` tarball was fetched via `scripts/fetch-upstream.ts`'s
`fetchAndVerifyUpstream()` (sha256 + npm registry sha512 integrity, both checked against the committed
`checksums.json` — both matched, unchanged from P2–P5's own verification since it is the same pinned
tarball; the verified sha256 is `207b771f…b40d95`, matching `checksums.json`). As P4/P5 did, this task
passed an explicit `cacheDir` under its own scratchpad, outside the repository; `fetchAndVerifyUpstream`
reports `ownedDir: false` in that mode, so this task deleted every cache and extraction directory itself
once every citation had been captured.

**Two independent fetch → extract → read → delete cycles were run**, per P4/P5's convention: one for
research and drafting, and a second, dedicated mechanical verification pass in which every `sdk.d.ts`
line citation in this document was written into a `file<TAB>line<TAB>expected-substring` table and
checked programmatically against the *second* extraction. Both cycles independently verified the same
checksum. The verification result is recorded at the end of this Method section.

Files examined: `sdk.d.ts` (8447 lines) and `sdk-tools.d.ts` (4125 lines), matching P4/P5's counts.
`bridge.d.ts`, `browser-sdk.d.ts`, `extractFromBunfs.d.ts` and `agentSdkTypes.d.ts` were swept for every
P6 symbol searched for and had **zero** independent hits.

**Prompt-text prohibition (WS-11 §6.2, phase Global Constraints).** No grep in either cycle ran over
`sdk.mjs`, `bridge.mjs`, `browser-sdk.js` or any bundle — only the six `.d.ts` files and
`package.json`. The pinned runtime's system prompt was never fetched, read, printed, quoted, summarized
or described, and no capture below prints a request body's `system` field or any tool description. The
capture harness logs request *method + path*, tool *names*, and structural counts only.

**Naming discipline**: identical to P2–P5's — the pinned identifier and field NAMES quoted below *are*
Winter's own naming (WS-03's compatibility posture, WS-07 §4). Every sentence of description, every
table, and this document's structure are original. Vendor prose is restated in this document's own
words throughout; the only vendor strings reproduced verbatim are runtime **error/identifier** strings
a capture exists specifically to pin, each labelled as such at its capture.

**Claim provenance**: as P4/P5 — each item distinguishes a *type-level fact* (a field exists, its type,
its optionality — evident from the declaration's code) from a *doc-asserted behavior* (a claim resting
on the artifact's own JSDoc) from a *runtime-captured fact* (observed by executing the pinned runtime
hermetically). All three carry their source; the second and third say so explicitly.

**Hermeticity of the runtime captures.** Every probe ran the pinned runtime with `env` set to exactly
`{ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, CLAUDE_CONFIG_DIR, HOME}` and NO `process.env` spread — the
`env` option replaces the child's environment wholesale, so `CLAUDE_CONFIG_DIR` **and** `HOME` were each
a fresh `mkdtemp`, closing both the config-dir path and the `os.homedir()` fallback path that
`CLAUDE_CONFIG_DIR` alone does not cover. `cwd` was a third fresh `mkdtemp`. `ANTHROPIC_BASE_URL` pointed
at a per-scenario `127.0.0.1` loopback returning canned public-Messages-API-shaped responses, and every
request it received was logged. The real `~/.claude`, `~/.winter`, `~/.norma` were never read or written;
no real username appears anywhere in this file, and every captured path is rendered as a template with
`<CLAUDE_CONFIG_DIR>` / `<CWD>` placeholders. The macOS Keychain caveat is stated at capture (I).

**Citation verification (second cycle).** _Recorded at the foot of this document under "Citation
verification"._

---

## (a) `SDKPartialAssistantMessage` — the `stream_event` frame

**Source**: `sdk.d.ts:4544-4558` (JSDoc `4541-4543`); gating option `Options.includePartialMessages`,
`sdk.d.ts:1712-1716`; union membership `sdk.d.ts:4399`.

```ts
type SDKPartialAssistantMessage = {
  type: 'stream_event';
  event: BetaRawMessageStreamEvent;   // 4549 — EXTERNAL, unpinned; see the headline finding
  parent_tool_use_id: string | null;  // 4550
  uuid: UUID;                         // 4551
  session_id: string;                 // 4552
  ttft_ms?: number;                   // 4553
  user_message_uuid?: string;         // 4557
};
```

**Six fields plus the discriminant — and only six.** The brief's item (a) asks for "`parent_tool_use_id`,
`uuid`, `session_id`"; the pin has two more the brief did not name: `ttft_ms?` (4553, no JSDoc of its own)
and `user_message_uuid?` (4557).

**The `event` union (doc-asserted, `sdk.d.ts:4547`).** The JSDoc directly above the field names exactly
six Anthropic Messages API streaming event types: `message_start`, `content_block_start`,
`content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`. **No delta *variant* is
named** (`text_delta`, `thinking_delta`, `signature_delta`, `input_json_delta` appear nowhere in the
pin's `event`-related text), and **no payload field of any member is declared**. Two members the
Messages API streams in practice are absent from that list — `ping` and `error` — yet `ping` is named
elsewhere in the pin (see `user_message_uuid` below), which is direct internal evidence that the
six-name list is a *representative* list and not an exhaustive union. Capture (F) is the field-level
authority; the pin cannot be.

**Gating (doc-asserted, `sdk.d.ts:1712-1715`)**: `includePartialMessages?: boolean` — when true,
`SDKPartialAssistantMessage` events are emitted during streaming. Unlike its neighbour
`includeHookEvents` (`sdk.d.ts:1702-1711`), it carries **no `@default` tag**; the default is implicit
(absent/falsy). `SDKPartialAssistantMessage`'s own JSDoc (`4542`) adds two behavioural claims: the
frames are emitted *only* when partial messages are requested, and **the complete assistant message
still follows as its own message** — i.e. `stream_event` is additive, never a replacement for the
`assistant` frame. That second claim is what makes a Winter host able to ignore `stream_event`
entirely and still see every completed block.

**`user_message_uuid` — a three-way stamping rule (doc-asserted, `sdk.d.ts:4555` + `3112`).** The two
JSDocs are complementary and must be read together:

- in complete-message mode the stamp rides the turn's **first `assistant` message** (`3112`);
- with partial messages on, it "normally" rides the **first non-`ping` `stream_event`** instead
  (`4555`, `3112`) — which is why `ping` is a real member of the `event` union despite the six-name
  list;
- a turn that produces no stream events still stamps its first `assistant` message (`3112`).

Absent on: every later frame of the turn, subagent frames (`parent_tool_use_id` set — stated at `3112`
for the assistant frame; the `stream_event` JSDoc at `4555` does *not* repeat the subagent carve-out),
synthetic/scheduled (meta) turns, turns without a client uuid, and older producers. It is a
**wrapper-level sibling, never inside `message.content`**, so it is not replayed to the model (`3112`).

**`parent_tool_use_id` is non-optional and nullable** (`string | null`, not `?:`) — a `stream_event`
frame always carries the field; `null` means the main thread. Same convention as `SDKAssistantMessage`
(`sdk.d.ts:3106`) and `SDKToolProgressMessage` (`sdk.d.ts:5030`), so a Winter frame emitter must emit
the key explicitly rather than omitting it for main-thread work.

**For the phase**: `stream_event` is the single pinned name for live token streaming (R6-5). Winter's
adapter-to-frame bridge produces this shape; the `event` payloads it produces are Winter's own
normalization target, and because the pin does not fix them, Winter must **declare** its own event
payload types rather than re-export a floating peer's (OQ-P6-1).

---

## (b) The provider-facing frame family and its gating

All eight requested types are members of the exported `SDKMessage` union (`sdk.d.ts:4399`), so they
reach an ordinary `for await (const msg of query(...))` consumer without any opt-in unless noted.

### `SDKAPIRetryMessage` — `sdk.d.ts:3085-3095` (JSDoc `3083`)

```ts
type SDKAPIRetryMessage = {
  type: 'system';
  subtype: 'api_retry';
  attempt: number;                 // 3088
  max_retries: number;             // 3089
  retry_delay_ms: number;          // 3090
  error_status: number | null;     // 3091
  error: SDKAssistantMessageError; // 3092
  uuid: UUID;                      // 3093
  session_id: string;              // 3094
};
```

Exactly the five payload fields the brief names, all **required** — none optional. Two type-level facts
worth pinning:

- `error_status` is `number | null`, and its JSDoc (`3083`) states the null case precisely: a connection
  error (e.g. a timeout) that had no HTTP response. Winter's own retry frame must be able to represent
  "retryable failure with no status", not just an HTTP code.
- `error` is **not a free string** — it is the closed 11-member `SDKAssistantMessageError` union
  (`sdk.d.ts:3159`): `'authentication_failed' | 'oauth_org_not_allowed' | 'account_on_hold' |
  'billing_error' | 'rate_limit' | 'overloaded' | 'invalid_request' | 'model_not_found' | 'server_error'
  | 'unknown' | 'max_output_tokens'`. That union is the pin's **provider-error taxonomy**, and it is the
  same type carried on `SDKAssistantMessage.error?` (`sdk.d.ts:3107`) and
  `StopFailureHookInput.error` (P2 item (b)). A Winter adapter that classifies a provider failure has
  exactly these eleven buckets to map into for parity; anything finer is a Winter extension to disclose.

**No gating option**: no `Options` field mentions `api_retry`, and `SDKAPIRetryMessage`'s JSDoc names
none. **No gate found** — it appears unconditional.

**A second carrier of the same counters**: `SDKControlRequestProgressMessage`
(`sdk.d.ts:4103-4117`, JSDoc `4101`) carries `status: 'started' | 'api_retry'` plus `attempt?`,
`max_retries?`, `retry_delay_ms?`, `error_status?` — **all optional there**, "present only for that
status" (doc-asserted, `4101`), and correlated by `request_id` (`4109`). Scope is a long-running
client-originated control request (doc-asserted: currently only `side_question`). So retry counters
appear on two frames with two different optionality rules; a Winter host projector must not assume one
shape.

### `SDKRateLimitEvent` / `SDKRateLimitInfo` — `sdk.d.ts:4638-4646` / `4651-4669`

```ts
type SDKRateLimitEvent = {
  type: 'rate_limit_event';        // 4639 — a TOP-LEVEL type, not a system subtype
  rate_limit_info: SDKRateLimitInfo;
  uuid: UUID; session_id: string;
};
```

Two structural facts that matter for Winter's own frame taxonomy:

- **It is not a `system` message.** `type` is the literal `'rate_limit_event'` (`4639`), unlike
  `api_retry`/`status`/`thinking_tokens`/the refusal pair, which are all `type: 'system'` with a
  `subtype`. `auth_status` (`3162`) and `tool_progress` (`5027`) share this top-level-type convention.
  Winter's frame union must reproduce the split or diverge deliberately.
- **Scope is narrow and doc-asserted twice** (`4641`, `4649`): rate-limit information *for claude.ai
  subscription users*. Every field of `SDKRateLimitInfo` except `status` is optional (`4652-4668`), and
  the vocabulary is consumer-subscription-shaped throughout — `rateLimitType`'s six members
  (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_overage_included`,
  `overage`), an overage sub-family (`overageStatus`, `overageResetsAt`, `overageDisabledReason`'s
  13 members, `isUsingOverage`, `overageInUse`, `surpassedThreshold`), and a credits sub-family
  (`errorCode?: 'credits_required'`, `canUserPurchaseCredits?`, `hasChargeableSavedPaymentMethod?`).
  `status` itself is `'allowed' | 'allowed_warning' | 'rejected'`; `resetsAt?` and `utilization?` are the
  only generic fields.

**Consequence for WS-13, stated plainly**: `rate_limit_event` in the pin is **not** a generic HTTP-429
signal. It is a subscription-quota level signal. An API-key-authenticated session (which is what every
hermetic capture and every Winter provider adapter is) has no subscription quota to report, so a Winter
adapter that emits `rate_limit_event` on a provider's HTTP 429 is *repurposing* the frame, not matching
it. The pinned 429 path is `api_retry` with `error_status: 429` and `error: 'rate_limit'`. Capture (G)
tests this directly. **No gating option found.**

### `SDKAuthStatusMessage` — `sdk.d.ts:3161-3168`

```ts
type SDKAuthStatusMessage = { type: 'auth_status'; isAuthenticating: boolean; output: string[]; error?: string; uuid: UUID; session_id: string };
```

Top-level `type`, four payload fields, **no JSDoc at all** — the pin says nothing about when it is
emitted, what `output` contains, or what gates it. `isAuthenticating: boolean` and `output: string[]`
read as a *login-flow progress* shape (a running transcript of an interactive auth attempt), not as a
per-request credential verdict. **No gate found.** Capture (I) probes whether a keyless run emits it at
all; the answer changes whether Winter's `auth_status` is a parity frame or a Winter extension.

### `SDKThinkingTokensMessage` — `sdk.d.ts:5017-5024` (JSDoc `5015`)

```ts
type SDKThinkingTokensMessage = { type: 'system'; subtype: 'thinking_tokens'; estimated_tokens: number; estimated_tokens_delta: number; uuid: UUID; session_id: string };
```

Doc-asserted semantics (`5015`), restated: the value is digested from a `thinking_delta`'s
`estimated_tokens` during the *redacted-thinking* phase, where the API otherwise streams only pings;
`estimated_tokens` is the running total for the **current thinking block** and `estimated_tokens_delta`
is this frame's increment; it is approximate progress for a spinner, explicitly **not** the billed
`output_tokens`. **No gating option found** — notably it is *not* tied to `includePartialMessages`,
which matters: a host that never opts into `stream_event` still gets thinking progress. This JSDoc is
also the pin's only mention of a `thinking_delta` field name (`estimated_tokens`), and it is
second-hand — a delta payload field named in prose about a different type. It is not a declaration of
the delta shape.

### `SDKModelRefusalFallbackMessage` — `sdk.d.ts:4476-4508` (JSDoc `4474`)

```ts
type SDKModelRefusalFallbackMessage = {
  type: 'system'; subtype: 'model_refusal_fallback';
  trigger: 'refusal';                                   // 4479 — a ONE-MEMBER union
  direction: 'retry' | 'revert' | 'sticky';             // 4480
  scope?: 'session' | 'local';                          // 4484
  original_model: string; fallback_model: string;       // 4485-4486
  request_id: string | null;                            // 4487
  api_refusal_category?: string | null;                 // 4491
  api_refusal_explanation?: string | null;              // 4496
  retracted_message_uuids?: string[];                   // 4500
  refused_user_message_uuid?: string | null;            // 4504
  content: string; uuid: UUID; session_id: string;
};
```

**The single most consequential fact in item (b) for the phase**: `trigger` is the literal `'refusal'`
and nothing else, and the JSDoc (`4474`) scopes emission to "the primary model ends the stream with
`stop_reason` 'refusal' and the turn is retried once on a fallback model". **A model-refusal fallback
is not an overload fallback.** `Options.fallbackModel`'s own text (item (g)) says the fallback exists
for a model that is "overloaded or unavailable" — but no frame in the pinned `SDKMessage` union
announces *that* swap. Capture (G) tests exactly this gap: with persistent 529 and `fallbackModel` set,
is there any frame at all, or is the only observable the `model` field of the outgoing request?

`direction`'s `'revert'`/`'sticky'` members are doc-marked as retained for consumer compat and no
longer emitted (`4474`) — a live example of a pinned union that is wider than pinned behaviour. `scope`
(`4482`) distinguishes a session-wide swap from a subagent/side-question-local one, and is absent on
older CLIs (treat as `'session'`). `api_refusal_explanation` is doc-marked unstable human prose,
display-only, never to be parsed (`4493-4495`) — a rule Winter should carry into its own frame.

### `SDKModelRefusalNoFallbackMessage` — `sdk.d.ts:4513-4523` (JSDoc `4511`)

Same family, emitted when the refusal produced **no** retry: no fallback configured, or per-category
routing declined it. Nine fields, no `trigger`/`direction`/`scope`/`fallback_model` (there is no
fallback to name). Its JSDoc names an env knob, `CLAUDE_CODE_REFUSAL_FALLBACK_CATCH_ALL`, and a
per-category fallback map — neither is declared as a type anywhere in the pin, so the routing policy
behind the frame is undocumented at the type level (the same shape of finding P2 recorded for
auto-mode policy config).

### `SDKStatusMessage` — `sdk.d.ts:4838-4848`

```ts
type SDKStatusMessage = { type: 'system'; subtype: 'status'; status: SDKStatus; permissionMode?: PermissionMode; compact_result?: 'success' | 'failed'; compact_error?: string; uuid: UUID; session_id: string };
type SDKStatus = 'compacting' | 'requesting' | null;   // 4836
```

No JSDoc. `SDKStatus` is a **three-state including `null`** — `null` is a member of the type, not an
absence, so a "back to idle" transition is expressible. `'requesting'` is the pin's only declared
"a provider request is in flight" signal, which makes this frame P6-relevant despite P4 having
recorded (item (b), "DEVIATION") that it is *not* an MCP-status message. The two `compact_*` fields
ride the same frame, so `status` doubles as the compaction-outcome carrier.

---

## (c) `ThinkingConfig`, `EffortLevel`, the numeric effort form, `maxThinkingTokens`

### `ThinkingConfig` — three arms, exactly the spellings WS-13 assumed

**Source**: `sdk.d.ts:8216` (the union, JSDoc `8214-8215`); `8208-8211` (`ThinkingAdaptive`, JSDoc
`8205-8207`); `8228-8232` (`ThinkingEnabled`, JSDoc `8226-8227`); `8221-8223` (`ThinkingDisabled`,
JSDoc `8218-8220`). Option field: `sdk.d.ts:1736` (JSDoc `1724-1735`).

```ts
type ThinkingConfig = ThinkingAdaptive | ThinkingEnabled | ThinkingDisabled;   // 8216

type ThinkingAdaptive = { type: 'adaptive'; display?: 'summarized' | 'omitted' };            // 8208-8211
type ThinkingEnabled  = { type: 'enabled'; budgetTokens?: number; display?: 'summarized' | 'omitted' }; // 8228-8232
type ThinkingDisabled = { type: 'disabled' };                                                // 8221-8223
```

Type-level facts worth flagging, because two of them contradict the option's own example text:

- **`ThinkingEnabled.budgetTokens` is OPTIONAL** (`8230`, `budgetTokens?: number`) even though the
  option's JSDoc renders the arm as `{ type: 'enabled', budgetTokens: number }` (`1728`). The
  declaration is the compile-time authority; the JSDoc example is illustrative. `{type:'enabled'}`
  with no budget is a well-typed value with undefined semantics in the pin.
- **`display` exists on two of the three arms** (`adaptive` and `enabled`) and is absent from
  `disabled` — the option's JSDoc never mentions `display` at all. Its members are `'summarized'` and
  `'omitted'`; the same pair recurs at `Query.setMaxThinkingTokens`'s second parameter
  (`sdk.d.ts:2496`, `thinkingDisplay?: 'summarized' | 'omitted' | null`) and on the wire control
  request (`sdk.d.ts:4175`, `thinking_display?: ('summarized'|'omitted') | null`) — where `null` is
  additionally a member, i.e. the *clearing* form exists only on the imperative surfaces, not in
  `ThinkingConfig`.
- Doc-asserted arm semantics (`8206`, `8227`, `8219`, and the option's own list at `1726-1730`):
  `adaptive` = the model decides when and how much to think, named as the default for models that
  support it, and version-scoped in the prose to Opus 4.6+; `enabled` = a fixed budget, prose-scoped to
  older models; `disabled` = no extended thinking. Precedence is stated twice (`1732`, `8215`):
  `thinking`, when set, takes precedence over the deprecated `maxThinkingTokens`.

### `EffortLevel` and the numeric form

**Source**: `sdk.d.ts:586` (the union, JSDoc `577-585`); option field `sdk.d.ts:1749` (JSDoc
`1737-1748`).

```ts
type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';   // 586
effort?: EffortLevel;                                              // 1749 — Options
```

**`Options.effort` does NOT admit a number.** The numeric form the brief asks about exists, but on
**three other surfaces**, each spelled inline as `('low'|'medium'|'high'|'xhigh'|'max') | number` or a
narrower variant — never as `EffortLevel` itself:

| Surface | file:line | Type |
| --- | --- | --- |
| `AgentDefinition.effort` (per-subagent) | 87 (JSDoc 84-86) | `('low'\|'medium'\|'high'\|'xhigh'\|'max') \| number` — **the only numeric-admitting effort field found** |
| `BaseHookInput.effort` (per-turn, hooks) | 187-190 | `{ level: string }` — a bare string, not the union (P2 item (b) already pinned the object; the `level` semantics are pinned here) |
| `SDKSystemMessage.effort` (init) | 4899 (JSDoc 4897) | `('low'\|'medium'\|'high'\|'xhigh'\|'max') \| null` — no number |
| `Settings.effortLevel` / `Settings.<model>.effortLevel` | 7579, 7588 | `'low'\|'medium'\|'high'\|'xhigh'` — **`'max'` excluded**, deliberately |
| `Query.setSettings`'s `effortLevel` key | 2520 (JSDoc 2514-2517) | `EffortLevel \| null` — re-widened to include `'max'` |

**Declaration comment on the numeric form's semantics — there is none.** `AgentDefinition.effort`'s
JSDoc (`84-86`) says only, restated: a reasoning effort level for the agent, either a named level or an
integer. **No unit, no range, no mapping rule, no relation to `budgetTokens` is stated anywhere in the
pin.** The brief asks for "any declaration comment on its semantics"; the answer is a documented
absence. The plan's own instruction — adapters map a numeric effort to the nearest verified tier and
disclose it — is therefore **not** a divergence from the pin; it is filling a gap the pin leaves open.
Recorded as OQ-P6-2.

Two adjacent doc-asserted rules that constrain a Winter effort mapper:

- `'max'` is **session-scoped and deliberately not persistable**: `Settings.effortLevel` excludes it,
  and `setSettings`'s JSDoc (`2514-2517`) says so explicitly, restated: `effortLevel` additionally
  accepts `'max'`, which is session-scoped, and `Settings.effortLevel` excludes it for that reason.
- Effort is **silently downgraded per model**. `BaseHookInput.effort.level`'s JSDoc (`189`) describes
  the value as the active level *after any silent downgrade for the selected model*, and
  `SDKSystemMessage.effort`'s (`4897`) as the level the session will send next *after env overrides,
  session state, org caps and model-support downgrades*, `null` when no effort parameter will be sent —
  including the case of "an internal numeric budget". That last clause is the pin's one hint that the
  numeric form is an internal representation the public frame declines to render.
- `ModelInfo.supportsEffort?` / `supportedEffortLevels?` (`1279-1285`, item (d)) are the pinned
  capability inputs to that downgrade — which is exactly WS-13's capability-honesty requirement, with
  the pin agreeing on the mechanism.

### `maxThinkingTokens` deprecation

**Source**: `sdk.d.ts:1758`, JSDoc `1750-1757`.

```ts
/** @deprecated Use `thinking` instead. … */
maxThinkingTokens?: number;
```

Doc-asserted, restated: the field caps the tokens the model may spend on reasoning; it is deprecated in
favour of `thinking`; **on Opus 4.6 it is reinterpreted as on/off** — `0` disables, any other value
means adaptive — and explicit control requires `thinking: {type:'adaptive'}` or
`thinking: {type:'enabled', budgetTokens: N}`. So the deprecated field's *semantics change by model*,
which is a real trap for a Winter compatibility shim: forwarding `maxThinkingTokens: 8000` is not
"budget 8000" on a modern model, it is "adaptive". The imperative twin `Query.setMaxThinkingTokens`
(`sdk.d.ts:2496`, JSDoc `2474-2495`) is **also `@deprecated`** — its own tag (`2483-2486`) repeats the
same Opus-4.6 on/off reinterpretation and redirects to the `thinking` option — and takes
`number | null` (null clears) plus the `thinkingDisplay` parameter above, whose three-way semantics
its JSDoc pins (`2489-2494`): a value replaces the session display mode, `null` clears the override so
the runtime's default handling applies again, and omission keeps the mode from session start.

---

## (d) `ModelInfo`, `supportedModels()`, `set_model`, `AccountInfo`, `ApiKeySource`, `system/init`

### `ModelInfo` — `sdk.d.ts:1261-1300` (JSDoc `1258-1260`)

```ts
type ModelInfo = {
  value: string;                    // 1265 — the id to use in API calls
  resolvedModel?: string;           // 1269 — canonical wire id this row's `value` resolves to
  displayName: string;              // 1273
  description: string;              // 1277
  supportsEffort?: boolean;         // 1281
  supportedEffortLevels?: ('low'|'medium'|'high'|'xhigh'|'max')[];  // 1285
  supportsAdaptiveThinking?: boolean; // 1289
  supportsFastMode?: boolean;       // 1293
  supportsAutoMode?: boolean;       // 1297
};
```

**Three required fields, six optional.** `description` being *required* is notable: a Winter catalog
row must carry one, and a catalog generated from an upstream extraction with a missing description
cannot satisfy this shape without inventing text. `resolvedModel`'s JSDoc (`1266-1268`) pins the alias
mechanism precisely, restated: it is the canonical wire model id the row's `value` resolves to (its own
example is an alias resolving to a dated id), so a host can match a persisted explicit id against the
alias row covering it. That is exactly WS-13's alias/canonical-id split, with the pin naming both
halves on one row rather than in two tables.

The four `supports*` booleans are the pin's entire capability vocabulary for a model — there is **no**
tool-support, vision, context-window, or streaming capability field on `ModelInfo` (context window and
max output tokens live on `ModelUsage` instead, item (e)). WS-13's three-state tool-capability model
has **no pinned counterpart**; it is a Winter extension to disclose. Recorded as OQ-P6-3.

### `supportedModels()` — `sdk.d.ts:2566` (JSDoc `2562-2565`)

```ts
supportedModels(): Promise<ModelInfo[]>;
```

A bare array — no envelope, no default marker, no "current model" field. The current model is read from
`SDKSystemMessage.model` (`4869`) instead, and the *account*/catalog pair is available together only on
the initialize response (below). **No `Query` method returns the currently selected model.**

The wire twin is `SDKControlListModelsRequest` (`sdk.d.ts:3855-3857`, JSDoc `3852-3854`), subtype
`'list_models'`, **payload-free**. Its JSDoc, restated, is the capability rationale: in a remote
thin-client session the worker's provider, settings cascade and enforcement policy decide which models
the session can run, so the client must ask rather than compute its own list — the pin's own argument
for a server-side catalog, which is the shape WS-13's discovery layer takes.

### `set_model` — `sdk.d.ts:4181-4188` (JSDoc `4178-4180`)

```ts
declare type SDKControlSetModelRequest = {
  subtype: 'set_model';
  model?: string | null;   // 4186 — omitted, null, or 'default' resets to the session default
};
```

**A three-way reset spelling** (doc-asserted, `4184`): omitted, `null`, **or the literal string
`'default'`** all reset to the session default model. A Winter implementation that accepts only
`undefined`/`null` as "reset" silently treats `'default'` as a model id.

Public method: `Query.setModel(model?: string): Promise<void>` (`sdk.d.ts:2473`, JSDoc `2467-2472`) —
**note the public signature is narrower than the wire type**: it takes `string | undefined`, not
`string | null`. Doc-asserted and load-bearing for capture (J): *only available in streaming input
mode* (`2469`). `SDKControlSetModelRequest` is **not exported** (`declare type`, no `export`), so the
wire subtype is internal — a Winter host bridge implementing it is implementing an unexported contract,
same posture P2 recorded for `SDKControlPermissionRequest`.

### `AccountInfo` / `accountInfo()` — `sdk.d.ts:23-33` (JSDoc `20-22`), `2632` (JSDoc `2628-2631`)

```ts
type AccountInfo = {
  email?: string; organization?: string; subscriptionType?: string;
  tokenSource?: string; apiKeySource?: string;   // note: a bare string, NOT ApiKeySource
  apiProvider?: 'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'anthropicAws' | 'anthropicGoogleCloud' | 'mantle' | 'gateway';  // 32
};
accountInfo(): Promise<AccountInfo>;
```

**Every field optional** — an empty object is a valid `AccountInfo`. Two findings:

- `AccountInfo.apiKeySource?: string` (`28`) is a **bare string**, while `SDKSystemMessage.apiKeySource`
  (`4860`) is the closed `ApiKeySource` union. The same concept is typed twice, differently, in one
  declaration.
- **`apiProvider`'s eight members are the pin's own provider-family enumeration** (`32`), and its JSDoc
  (`29-31`) states, restated: it names the active API backend; Anthropic OAuth login applies only when
  `'firstParty'`; for third-party providers the other fields are absent and auth is external (AWS
  credentials, gcloud ADC and so on); `'gateway'` means authentication against an enterprise gateway.
  Winter's Phase-6 native-cloud trio maps onto `bedrock`/`vertex`/`foundry` here, and its explicit
  gateway family onto `'gateway'` — the pin independently arrives at the same partition WS-13 draws,
  which is corroboration worth citing in the lane briefs.
- `ModelUsage.provider?` (`1318`, item (e)) carries the *same vocabulary* as a bare string, again
  untyped.

### `ApiKeySource` — `sdk.d.ts:127` (JSDoc `124-126`)

```ts
type ApiKeySource = 'ANTHROPIC_API_KEY' | 'apiKeyHelper' | '/login managed key' | 'none'
                  | 'user' | 'project' | 'org' | 'temporary' | 'oauth';
```

Nine members, of which the JSDoc marks the last **five** as legacy that current CLIs never emit,
retained only for backward compatibility — so the *live* value set is four:
`'ANTHROPIC_API_KEY'`, `'apiKeyHelper'`, `'/login managed key'`, `'none'`. `'none'` is doc-asserted to
mean *no API key in use*, explicitly including a claude.ai OAuth login, a bearer token, or a third-party
cloud provider — i.e. **`'none'` does not mean unauthenticated**. Any Winter code that treats
`apiKeySource === 'none'` as "no credential" is wrong on exactly the OAuth and Bedrock/Vertex paths P6
adds. One member contains a space and a slash (`'/login managed key'`), which will bite any consumer
that treats these as identifiers.

### `system/init` — `sdk.d.ts:4853-4913` (JSDoc `4850-4852`)

Fields relevant to (d): `apiKeySource: ApiKeySource` (**required**, `4860`), `betas?: string[]`
(`4861`), `model: string` (**required**, `4869`), `effort?: (…)|null` (`4899`), plus
`claude_code_version`, `cwd`, `tools`, `mcp_servers`, `permissionMode`, `slash_commands`,
`output_style`, `skills`, `plugins`, `agents?`, `terminal_slash_commands?`, `fast_mode_state?`,
`fast_mode_disabled_reason?`, `capabilities?`, `uuid`, `session_id`.

**Correction to the brief (a brief-vs-pin mismatch, not a spec divergence).** The brief lists
"`system/init`'s `apiKeySource`/`betas`/**account**/model fields". **`SDKSystemMessage` has no `account`
field.** Account information rides a different surface entirely:
`SDKControlInitializeResponse.account: coreTypes.AccountInfo` (`sdk.d.ts:3804`, JSDoc `3801-3803`),
returned by `initialize`/`reinitialize()` (`sdk.d.ts:2554`), alongside `models: coreTypes.ModelInfo[]`
(`3799`). So a `query()` consumer that only iterates the message stream **never sees account info at
all** — it must call `accountInfo()` or `reinitialize()`. Winter's `system/init` must not grow an
`account` field for parity; parity is the initialize *response*.

`betas?: string[]` is a bare string array on the frame. The pin's only *typed* beta is
`SdkBeta = 'context-1m-2025-08-07'` (`sdk.d.ts:3192`) — a one-member union used elsewhere in `Options`;
the init frame does not use it. `capabilities?: string[]` (`4903`) is doc-asserted to be an **open set**
for feature detection, with three named members; its JSDoc explicitly instructs consumers to ignore
unknown values, which is the pin's own forward-compat convention and the right one for Winter's frame.

---

## (e) `NonNullableUsage`, `ModelUsage`, `costBasis`, `total_cost_usd`, `SDKContextUsage`

### `NonNullableUsage` — `sdk.d.ts:1325-1327`

```ts
type NonNullableUsage = { [K in keyof BetaUsage]: NonNullable<BetaUsage[K]> };
```

A mapped type over the **unpinned external** `BetaUsage` (headline finding). What the pin fixes: the
rule that every key of the upstream usage object is non-nullable on `SDKResultSuccess.usage`
(`sdk.d.ts:4740`). What the pin does **not** fix: which keys exist. Note the mapping strips `null`/
`undefined` from each value type but does **not** make optional keys required — an optional key stays
optional with a non-nullable value type. Field names come from capture (K).

### `ModelUsage` — `sdk.d.ts:1302-1323`

```ts
type ModelUsage = {
  inputTokens: number; outputTokens: number;
  cacheReadInputTokens: number; cacheCreationInputTokens: number;
  webSearchRequests: number; costUSD: number;
  contextWindow: number; maxOutputTokens: number;
  canonicalModel?: string;                          // 1314
  provider?: string;                                // 1318
  costBasis?: 'list' | 'managed' | 'unknown';       // 1322
};
```

Eight required numeric fields, three optional strings/unions. `contextWindow` and `maxOutputTokens`
riding the *usage* record rather than `ModelInfo` is the pin's own placement of two facts WS-13 treats
as catalog data — worth noting for the extractor lane: the pinned runtime learns them per request, not
from a catalog.

**`costBasis` (`1322`, JSDoc `1319-1321`)** — doc-asserted, restated: it records which price table the
**most recent** request for this model was priced at — Claude Code's built-in list prices (`'list'`),
the organization's managed-settings rates or multiplier (`'managed'`), or neither (`'unknown'`, meaning
no pricing row and no built-in price matched the model id, so `costUSD` is a guess at the default
model's rate). Three further behaviours the same comment pins, each load-bearing for Winter's cost
honesty:

1. it is **overwritten per request**, like `canonicalModel` — so differencing cumulative `costUSD` per
   turn yields that turn's basis;
2. it is **absent until this process has priced a request** for the model (e.g. right after a resume);
3. absence is doc-instructed to be **treated as `'list'`** — a default that quietly converts "we don't
   know" into "list price" on a resumed session.

`'unknown'` is precisely the state a Winter-registered third-party model would be in, and the pin's own
guidance is that `costUSD` is then a guess at the *default model's* rate. For WS-13's evidence-dated
capability/cost claims this is the pinned precedent: **the field exists to say the number is untrusted**,
and Winter should carry a `costBasis`-shaped honesty marker rather than a bare number. Capture (K)
measures which value a fake model id actually produces.

`canonicalModel?` (`1314`, JSDoc `1311-1313`): the canonical id used for the pricing lookup, which may
differ from the raw model string the entry is **keyed** by (provider-specific ids, aliases). So
`modelUsage`'s *key* is the raw string and `canonicalModel` is the resolved one — the same
raw/canonical split `ModelInfo.value`/`resolvedModel` draws, third occurrence of the pattern.

`provider?` (`1318`) is a bare string whose JSDoc examples are the `AccountInfo.apiProvider` members.

### `result.total_cost_usd` — `sdk.d.ts:4682` (error arm) / `4736` (success arm), JSDoc `4678-4681` / `4732-4735`

Required `number` on both result arms. Doc-asserted lifecycle, restated: it is a cumulative estimate in
USD for this `query()` call, covering the same query-pipeline calls as `modelUsage`; in
streaming-input sessions each result carries the running total so far, so a consumer reads the latest
result rather than summing across results; crash/startup-error results may carry zeroed values; resumed
sessions start fresh; a mid-session `/clear` resets the running total; and it is an estimate, not a
billing statement. `modelUsage` (`4690`/`4744`, JSDoc `4687-4689`/`4741-4743`) is doc-asserted to be
the *correct* field for token/cost accounting — it spans main loop, Task subagents, sidechains and
internal calls such as compaction and Workflow agents, while excluding out-of-pipeline helper calls
(the permission classifier, token-count probes). The sibling `usage: NonNullableUsage` is doc-marked
**MAIN AGENT LOOP ONLY** (`4684`/`4738`) and explicitly deprioritised in favour of `modelUsage`.

`SDKResultError` (`4671-4708`) carries the identical `total_cost_usd`/`usage`/`modelUsage` trio, so a
failed turn still reports cost. Its `subtype` union (`4673`) is
`'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries'`
— **four members, none provider-specific**; there is no `error_auth`, `error_model_not_found` or
`error_overloaded` result subtype. That constrains capture (I): a credential or unknown-model failure
must surface as one of these four (most plausibly `error_during_execution`), as a thrown exception, or
as `is_error: true` on the `success` subtype — the pin leaves all three open, and
`SDKResultSuccess.is_error`/`api_error_status?: number | null` (`4728-4729`) exist precisely so the
success arm can carry an API failure.

### `SDKContextUsage` — `sdk.d.ts:3243-3304` (JSDoc `3240-3242`)

Required: `model`, `total_tokens`, `raw_max_tokens`, `percentage`, `categories`, `mcp_tools[]`,
`memory_files[]`, `agents[]`. Optional: `over_limit?: {tokens_over: number; kind: 'hard_limit' |
'compaction_window'}` and `skills?[]`. `SDKContextUsageCategory` (`3309-3319`) is
`{name: string; tokens: number; kind: 'used'|'free'|'buffer'|'deferred'}`, with its JSDoc instructing
consumers to classify on `kind` and never on the display `name`. Two doc-asserted subtleties for a
Winter context reporter: `total_tokens` is **unclamped** and may exceed `raw_max_tokens` (`3249`);
and `over_limit.kind` describes *how the window was resolved*, not whether the API will accept the next
request (`3261`). The type carries an explicit **additive-evolution promise** (`3241`): new optional
fields only, a breaking reshape would ship as a sibling field. It rides
`SDKAssistantMessage.context_usage?` (`3144`, JSDoc `3141-3143`) as a wrapper-level sibling on the
synthetic assistant message that delivers the `/context` markdown, never inside `message.content`.

---

## (f) The content-block question — answered from the runtime, because the pin does not declare it

**Declaration verdict, stated unambiguously: `thinking`, `redacted_thinking`, `image` and
`tool_result` block shapes are NOT declared in the pinned artifact.** Exhaustive, independently
reproduced absence across all six `.d.ts` files:

- `redacted_thinking` — **zero occurrences**, in any file, in any casing.
- a `type: 'thinking'` block literal — **zero occurrences**.
- `signature` as a *content-block field* — **zero occurrences**. The four hits of the string are:
  `SDKAssistantMessage.resumed_from_incomplete_thinking`'s JSDoc (`sdk.d.ts:3116`) and three unrelated
  AWS SigV4 sandbox-proxy settings (`7454`, `7458`, `7462`).
- `tool_result` appears **only in prose** — 14 JSDoc mentions across `sdk.d.ts`/`sdk-tools.d.ts`, never
  as a declared block type.

Every block shape is delegated to `BetaMessage` / `MessageParam` (`sdk.d.ts:1`, `:8`), from the
floating peer `@anthropic-ai/sdk >=0.93.0`. The pin's own prose says so twice, in words this document
restates: `SDKAssistantMessage.message`'s JSDoc (`3103`) describes the value as shaped like an
Anthropic Messages API assistant `Message` — id, model, content blocks (text, thinking, tool_use, …),
stop_reason and usage — and refers the reader to the Messages API reference for the block types; and
`SDKUserMessage.message`'s (`5062`, repeated at `5113`) does the same for a user `MessageParam` whose
content is a string or an array of blocks (text, image, document, tool_result, …).

**So the answer to "does the pinned assistant `thinking` block require `signature`?" is: the pinned
artifact does not say.** R6-8 must be re-grounded. Two things the pin *does* fix, both of which support
R6-8's conclusion by a different route:

1. **`thinking` is named as a real assistant content-block type** (`3103`) — so it is in-dialect, and a
   Winter `reasoning_summary` frame is not competing with an undeclared concept.
2. **Signatures are cumulative and replay-critical.** `SDKAssistantMessage.resumed_from_incomplete_thinking?: true`
   (`sdk.d.ts:3118`, JSDoc `3115-3117`) exists for exactly one situation, restated: the turn continued
   the preceding truncated assistant turn *inside its trailing signed thinking block* (max-output-tokens
   recovery), its thinking signatures are **cumulative over that preceding thinking-only turn**, and a
   history replayed through the bridge must carry the flag back so the normalizer keeps the run's prefix
   on the wire. A declaration does not add a wrapper-level flag whose sole purpose is preserving a
   signature chain across replay unless the signature is load-bearing on the wire. That is strong
   circumstantial support for R6-8 — **circumstantial, and labelled as such** — and it is a second,
   independent reason a foreign (unsigned) summary must not be written into
   `assistant.message.content`: doing so would corrupt a chain the pin treats as cumulative.

Capture (F) supplies the direct behavioural evidence: what the runtime does with a canned thinking
block **with** a signature versus **without** one, and whether the block is replayed verbatim into the
next request. See its verdict below; that verdict, not this section, is R6-8's factual base.

**`image` / `tool_result.content`**: likewise undeclared. `sdk-tools.d.ts` prose confirms the runtime
*produces* image blocks in a model-facing `tool_result` — `Read`'s output type notes (`sdk-tools.d.ts:334`, `:338`)
describe extracted page images delivered solely as image blocks in the model-facing `tool_result`
content and not retained on the tool_use_result. So **`tool_result.content` admits blocks, not only a
string**, established from the pin's own prose about its own tool, not from the external declaration.
The `source` variants of an image block are not pinned anywhere.

---

## (g) `Options.model` and `Options.fallbackModel`

**Source**: `sdk.d.ts:1798` (JSDoc `1794-1797`); `sdk.d.ts:1540` (JSDoc `1535-1539`).

```ts
model?: string;          // 1798 — "Claude model to use. Defaults to the CLI default model." + id examples
fallbackModel?: string;  // 1540
```

`Options.model`'s JSDoc is two sentences: it names the field as the Claude model to use, states that it
defaults to the CLI default model, and gives three full model-id examples. **No alias list, no
resolution rule, no validation claim** — the pin never says what happens to an unrecognised id, which
is what capture (I) probes.

**`fallbackModel`'s comment carries the phase's most consequential trigger text** (doc-asserted,
`1535-1539`, restated): it names fallback model(s) used **if the primary model is overloaded or
unavailable**; it **accepts a comma-separated list to try each in order**; and **the primary model is
re-tried at the start of each user turn, so a temporary outage does not permanently demote the
session.**

Three findings from that:

1. **The type is a single `string` carrying a list** — the comma-separated multi-value form is a
   *string convention*, not a `string[]`. A Winter option typed `string[]` would be a divergence.
2. **The trigger named in the comment ("overloaded or unavailable") does not match any pinned frame.**
   The only fallback frames are the refusal pair (item (b)), whose `trigger` is the literal `'refusal'`.
   The pin thus documents an overload-fallback behaviour it emits no frame for. Capture (G) tests
   whether one exists undeclared; if not, this is a genuine observability gap Winter can close as a
   disclosed extension.
3. **Re-promotion is per-user-turn and automatic.** A Winter fallback that stays demoted for the
   session diverges from the pinned semantics.

**The settings twin diverges in type**: `Settings.fallbackModel?: string[]` (`sdk.d.ts:5577`, JSDoc
`5574-5576`) is an **array**, each element a model name or alias, with the literal `"default"` expanding
to the default model, and **`--fallback-model` (the CLI flag, i.e. the `Options` value) takes
precedence**. So one concept has two pinned shapes — comma-separated string on `Options`, array in
settings — and a documented precedence between them. `Settings.model?: string` (`5573`) is the settings
twin of `Options.model`. Adjacent and relevant to WS-13's enforcement story:
`Settings.availableModels?: string[]` (`5581`, JSDoc `5578-5580`) is an allowlist accepting family
aliases, version prefixes and full ids, where undefined means all models and an **empty array means
only the default model** — an inversion worth pinning, since an empty allowlist naively read as "deny
all" is wrong.

---

## (h) `SessionKey.subpath` for non-transcript keys (R6-7a)

**Source**: `sdk.d.ts:5196-5207` (`SessionKey`, JSDoc `5191-5195`); `5279-5357` (`SessionStore`);
`5372-5377` (`SessionStoreEntry`, JSDoc `5360-5371`); `4460-4471` (`SDKMirrorErrorMessage`).

```ts
type SessionKey = {
  projectKey: string;   // 5201 — caller-defined scope; default: sanitized cwd; >200 chars truncated + djb2-hashed
  sessionId: string;    // 5202
  subpath?: string;     // 5206
};
```

**What the declaration says about `subpath`, in three sentences of JSDoc (`5203-5205`), restated:**
undefined means the main transcript; it is set for subagent files; **the empty string is invalid** —
the field is to be omitted for the main transcript; and it is **opaque to the adapter, to be used
simply as a storage-key suffix.** The type's own JSDoc (`5191-5195`) adds that main transcripts have no
subpath while subagent transcripts carry one mirroring the on-disk directory structure, and gives the
shape of the subagent form as an example.

**Verdict for R6-7a: a non-transcript subpath such as `"provider-state"` is admissible under the pinned
contract, and admissible *by the contract's own words* rather than by silence.** "Opaque to the
adapter — just use it as a storage key suffix" is a positive licence: nothing in the type ties the value
to a transcript, a directory, or the subagent form. The only hard constraints are (i) non-empty and
(ii) omitted for the main transcript. Four consequences a Lane C implementation must design around,
each a type-level or doc-asserted fact rather than an inference:

1. **Entries must satisfy `SessionStoreEntry`** (`5372-5377`): `{type: string; uuid?: string;
   timestamp?: string; [k: string]: unknown}` — a **required string `type` discriminant**. A sidecar
   record shaped `{kind: "origin", …}` with no `type` does **not** type-check as a store entry. The
   `kind` field R6-7 specifies must therefore ride *alongside* a `type`, not instead of it.
2. **`uuid` is the idempotency key** (doc-asserted, `5290-5294`): adapters SHOULD upsert/ignore-duplicate
   on `uuid`, and entries without one are appended without dedup. R6-7's `anchorUuid` is *not* the entry's
   own `uuid`; a sidecar record that sets `uuid` to the anchor would make every record for one assistant
   entry collide into a single upserted row. Give each record its own `uuid` and keep `anchorUuid` as a
   payload field.
3. **`load()` returns `SessionStoreEntry[] | null`, and `null` is ambiguous by design** (`5314`,
   JSDoc `5306-5313`): adapters that cannot distinguish "never written" from "emptied" may return
   `null` for both, and returned entries need only be **deep-equal**, not byte-equal — the SDK never
   hashes or byte-compares them. So a store-backed provider-state chain **cannot be integrity-checked
   by hashing**, and "no sidecar" is indistinguishable from "sidecar emptied". R6-7's degrade-to-summary
   path is therefore the *only* available response to a missing chain, which is what R6-7 already
   specifies — the pin corroborates the design.
4. **Discovery of a non-transcript subpath requires the optional `listSubkeys`** (`5353-5356`, JSDoc
   `5348-5352`): it lists all subpath keys under a session and is used during resume to discover and
   materialize subagent data; **if undefined, resume only materializes the main transcript.** So a
   provider-state subpath in a store whose adapter omits `listSubkeys` is written and never found on
   resume — silently. Winter must call `load()` on the known `"provider-state"` key **directly** rather
   than relying on enumeration.

Adjacent pinned facts that bound the sidecar's durability story: `append()` is doc-asserted to be
called **after** the local write succeeds, at roughly 100 ms batching cadence, with in-process
append-order persistence but cross-process ordering by storage commit time (`5280-5289`); rejection is
retried 3 times with short backoff, 60 s timeouts are **not** retried, and after final failure **the
batch is dropped** and an `SDKMirrorErrorMessage` is emitted (`5296-5300`, `4458`). That message's own
`key` field (`4464-4468`) re-states the `{projectKey, sessionId, subpath?}` triple — so the pin's own
failure frame is subpath-aware, further evidence that non-transcript subpaths are within contract.
Finally, `Options.sessionStore`'s JSDoc (`1673-1681`) pins the mirror as **dual-write, never a
replacement** (P5 item (e) already recorded this): the subprocess still writes to `CLAUDE_CONFIG_DIR`
and *additionally* emits to the adapter, and it cannot be combined with `persistSession: false`.

---

## Hermetic captures

Six captures ran against the checksum-verified pinned runtime under the hermeticity contract in Method.

**Harness note (a deviation from the brief's letters, recorded rather than silently renamed).** The
brief and the plan say "scenarios D–H". `scripts/capture-official-golden.ts` **already had scenarios D
and E** (Phase 4 Task 8, rider 8: advertised tool schemas; `MAX_MCP_OUTPUT_TOKENS`). Reusing those
letters would have overwritten committed P4 evidence, so this task's six scenarios are lettered
**F–K**, continuing the existing sequence. Mapping:

| Brief capture | Scenario | Subject | Verdict |
| --- | --- | --- | --- |
| (1) | **F** | `includePartialMessages` — `stream_event` ordering over text + thinking + tool_use | **captured** — and it answers R6-8 |
| (2) | **G** | 529→200, 429 + `retry-after`/`anthropic-ratelimit-*`, persistent 529 + `fallbackModel` | _pending_ |
| (3) | **H** | **WS-17 probe (a)** — neighbour-file survival across resume | _pending_ |
| (4) | **I** | no API key; unknown model — the failure shape | _pending_ |
| (5) | **J** | `supportedModels()` / `setModel()` | _pending_ |
| (6) | **K** | `total_cost_usd` / `modelUsage` / `costBasis` for a fake model id | _pending_ |

### Capture (F) — the six-name union is exactly right, `ping` is filtered, and an unsigned thinking block is normalised to `signature: ""`

**Design.** Two runs against the same loopback policy, differing in one variable. Both drive a real
SSE turn: `message_start` → a `thinking` block (`thinking_delta`, then in run (i) a `signature_delta`)
→ a `text` block (two `text_delta`s) → a `tool_use` block for the built-in `Read` on a fresh mkdtemp
file (two `input_json_delta`s) → `message_delta` (`stop_reason: "tool_use"`) → `message_stop`; the
request carrying the `tool_result` gets a plain text `end_turn` stream. A `ping` event is injected
after the thinking block's `content_block_start`. Run (i) sends the thinking block **with** a
signature; run (ii) sends it with **no `signature` key and no `signature_delta`** — the discriminator
for R6-8. Options: `includePartialMessages: true`, `thinking: {type:'enabled', budgetTokens:1024}`,
`permissionMode: 'bypassPermissions'`, `settingSources: []`.

**The loopback saw exactly four requests per run** — `HEAD /api/hello`, then three
`POST /v1/messages` — and nothing else.

**Result — the `event` union.** 21 `stream_event` frames in run (i), 20 in run (ii) (one fewer: the
absent `signature_delta`). The distinct `event.type` values observed, in first-seen order, are
**exactly the pinned JSDoc's six names and no others**:

```
message_start → content_block_start → content_block_delta → content_block_stop → message_delta → message_stop
```

**`ping` never reaches the consumer** (`"did a ping reach the consumer?": false` in both runs). The
pinned six-name list at `sdk.d.ts:4547` is therefore *exhaustive for what a host observes*, even
though `ping` demonstrably exists on the wire — the runtime filters it before the frame is emitted.
That reconciles the apparent contradiction item (a) flagged between the six-name list and
`user_message_uuid`'s "first **non-ping** stream event" wording: the wording describes the runtime's
internal stamping choice, not a frame a host can see.

**Result — the delta variants.** Four `content_block_delta` `delta.type` values were forwarded
verbatim: `thinking_delta`, `signature_delta`, `text_delta`, `input_json_delta`. Three
`content_block.type` values on `content_block_start`: `thinking`, `text`, `tool_use`. None of these
eight names is declared anywhere in the pin — this capture is their only authority in this document.

**Result — the frame's own key set.** The union of top-level keys across every observed
`stream_event` is exactly `["event", "parent_tool_use_id", "session_id", "ttft_ms", "type", "uuid"]`.
`user_message_uuid` appeared on **zero** frames, matching its JSDoc's "turns without a client uuid"
carve-out — a single-shot `query({prompt: string})` has no client-supplied uuid to stamp, so
**capture (1)'s `user_message_uuid` sub-question is answerable only from streaming-input mode**, which
this shape cannot reach (the same structural limit T10 and P2 recorded). `ttft_ms` appeared on exactly
**2** frames — one per *forwarded* turn, on that turn's `message_start`.

**Result — the auxiliary call, and why the arithmetic matters.** Three POSTs, but only two turns'
worth of stream events reach the consumer (15 + 6 = 21 in run (i); 14 + 6 = 20 in run (ii)). The
**first** POST is an auxiliary call, distinguishable by its envelope: `thinking: {"type":"disabled"}`,
**0 tools**, and no `context_management` key, against the two real turns' `thinking:
{"type":"adaptive"}`, **24 tools**, and `context_management` present. **Its stream events are not
forwarded to the host at all.** A Winter frame emitter that streams every provider call would emit
frames the pinned runtime suppresses.

**Result — one assistant message per completed content block, confirmed.** 4 completed `assistant`
frames per run: three for turn 1 (thinking, text, tool_use — one per block) and one for turn 2. This
is a direct runtime confirmation of `SDKAssistantMessage`'s JSDoc (`sdk.d.ts:3098`) and of
`SDKPartialAssistantMessage`'s "the complete assistant message still follows" claim (`4542`).

**Result — item (c)'s wire spelling, and a divergence between option and wire.** The option was set to
`{type:'enabled', budgetTokens: 1024}`. **The wire carried `"thinking": {"type": "adaptive"}`** on both
real turns. So the runtime did not forward the requested arm: it resolved `enabled` to `adaptive` for
this model (`claude-sonnet-5`, itself the resolution of the `"sonnet"` alias, visible in the request's
`model` field). A Winter adapter that forwards `ThinkingConfig` verbatim diverges from the pinned
runtime, which **re-resolves the arm against the model's capability** — exactly the silent-downgrade
behaviour item (c) derived from `ModelInfo.supportsAdaptiveThinking` and the effort JSDocs, now
observed on the thinking axis too. Recorded as OQ-P6-9.

Request envelope top-level keys, both real turns:
`context_management, max_tokens, messages, metadata, model, output_config, stream, system, thinking, tools`
(`max_tokens: 64000`, `stream: true`, 24 tools).

**Result — R6-8, answered directly.**

| Run | canned block | replayed into request 3 | `signature` key present on the replay | value |
| --- | --- | --- | --- | --- |
| (i) signed | `thinking` + `signature_delta` | **yes, verbatim** | yes | the canned signature, byte-identical |
| (ii) unsigned | `thinking`, **no signature at all** | **yes** | **yes — the runtime added it** | `""` (empty string) |

The completed `assistant` frame in run (ii) carries `"signature": ""` on its thinking block. **The
pinned runtime never emits or replays a thinking block without a `signature` key — when the stream
carries none it materialises the empty string.** That is the behavioural form of "required": the
field is structurally mandatory in the runtime's own normalizer, and whatever it holds is replayed
byte-for-byte into the next request's `messages`.

**What this settles for R6-8.** A foreign summary written into `assistant.message.content` as a
`thinking` block would go on the wire as a block with an **empty or fabricated signature**, which is
precisely the impersonation R6-8 exists to forbid — and the pinned runtime gives no mechanism to omit
the field instead. R6-8's conclusion stands; its *justification* should cite this capture plus
`resumed_from_incomplete_thinking` (item (f)), not the undeclared `ThinkingBlock`. Anthropic-family
thinking blocks ride in-dialect with their real signatures, exactly as R6-8 says; everything foreign
belongs in the sidecar and on the Winter-only `reasoning_summary` frame.

**Two things this capture cannot show**, stated rather than implied: whether a *real* Anthropic
endpoint rejects an empty signature (the loopback accepts everything), and whether `redacted_thinking`
is handled differently (no such block was streamed — its shape stays underived, item (f)).

---

## Open questions / divergences

1. **OQ-P6-1 — Winter must declare its own wire block/stream types, or inherit a floating peer's.**
   The pin imports every content-block and stream-event shape from `@anthropic-ai/sdk >=0.93.0`, an open
   lower bound outside `checksums.json` (headline finding). Re-exporting the peer's types gives free
   parity and free drift; declaring Winter's own gives a stable contract that can silently diverge from
   the real wire. This is a spine decision, not a lane decision.
2. **OQ-P6-2 — numeric effort has no pinned semantics.** `AgentDefinition.effort` (`sdk.d.ts:87`) admits
   a number; no unit, range or mapping rule is stated anywhere in the pin, and
   `SDKSystemMessage.effort`'s JSDoc (`4897`) says the frame reports `null` when the session is running
   on "an internal numeric budget". The plan's nearest-verified-tier mapping is filling a documented
   gap, not diverging — but the *disclosure wording* should say so.
3. **OQ-P6-3 — three-state tool capability has no pinned counterpart.** `ModelInfo`'s capability
   vocabulary is four booleans (`supportsEffort`, `supportsAdaptiveThinking`, `supportsFastMode`,
   `supportsAutoMode`) plus `supportedEffortLevels`. There is no tool-support, vision, streaming or
   context-window field. WS-13's three-state tool honesty is a Winter extension to disclose.
4. **OQ-P6-4 — `rate_limit_event` is a subscription-quota frame, not an HTTP-429 frame.** Both its
   JSDocs scope it to claude.ai subscription users and its whole vocabulary is quota/overage/credits
   shaped (`sdk.d.ts:4638-4669`). Emitting it on a provider 429 is repurposing. Does Winter (a) keep it
   for subscription-shaped providers only and route 429s to `api_retry`, matching the pin, or (b)
   generalise it and disclose? Capture (G) supplies the pinned behaviour; the ruling is the controller's.
5. **OQ-P6-5 — the pin documents an overload fallback it emits no frame for.** `Options.fallbackModel`
   (`1535-1539`) triggers on "overloaded or unavailable"; the only fallback frames are the refusal pair,
   whose `trigger` is the literal `'refusal'` (`4479`). If capture (G) finds no frame, Winter's own
   overload-fallback frame is a disclosed extension with no parity risk — but it must not be spelled
   `model_refusal_fallback`.
6. **OQ-P6-6 — R6-8's premise cannot be confirmed from the pin.** Whether an assistant `thinking` block
   requires `signature` is not derivable from the pinned artifact (item (f)). The
   `resumed_from_incomplete_thinking` flag (`3118`) is strong circumstantial support and capture (F) is
   the direct evidence; R6-8's justification text should cite those rather than "Anthropic's
   `ThinkingBlock` does".
7. **OQ-P6-7 — `SessionStoreEntry` requires a `type` discriminant.** R6-7's record shape
   (`{sessionId, anchorUuid, provider, model, family, itemIndex, kind, payload}`) has no `type` field,
   so as written it does not satisfy the store-backed variant R6-7a mandates (item (h), consequence 1),
   and its `anchorUuid` must not be reused as the entry `uuid` (consequence 2). A shape amendment, not a
   design change.
8. **OQ-P6-8 — `costBasis` absence is doc-instructed to mean `'list'`.** The pin turns "unknown" into
   "list price" on any resumed session (`1320-1323`). Winter's cost honesty layer should decide
   deliberately whether to reproduce that default or to keep absence distinguishable, and disclose it.

9. **OQ-P6-9 — the runtime re-resolves `ThinkingConfig` against the model; it does not forward it.**
   Capture (F) set `thinking: {type:'enabled', budgetTokens:1024}` and the wire carried
   `{"type":"adaptive"}`. Does Winter's provider seam forward the caller's arm verbatim (simpler, and
   the caller can be told what happened) or re-resolve it per model as the pin does (parity, but a
   silent rewrite the caller cannot see)? Whichever is chosen must be disclosed — this is the thinking
   axis of the same silent-downgrade behaviour OQ-P6-2 records for effort.
10. **OQ-P6-10 — auxiliary provider calls are invisible on the pinned frame stream.** Capture (F)
   observed a third `POST /v1/messages` per run (thinking disabled, zero tools, no
   `context_management`) whose stream events are **not** forwarded to the host. Winter must decide
   whether its own auxiliary calls (classifier, compaction, title) are likewise frame-invisible —
   matching the pin — or observable, and whether `modelUsage` still books them (the pin says it does
   for pipeline calls and does not for the classifier, item (e)).

## Notes recorded but not treated as Open Questions

No spec text is contradicted by any of these; recorded because they surfaced during (a)–(h).

- `SDKAPIRetryMessage.error` is the closed 11-member `SDKAssistantMessageError` union (`3159`), the
  pin's whole provider-error taxonomy, reused on `SDKAssistantMessage.error?` and `StopFailure`.
- `SDKPartialAssistantMessage` carries two fields the brief did not name: `ttft_ms?` (`4553`) and
  `user_message_uuid?` (`4557`).
- `set_model` treats the literal string `'default'` as a reset (`4184`), and the public
  `Query.setModel` signature (`string | undefined`) is narrower than the wire type
  (`string | null | undefined`).
- `AccountInfo.apiKeySource` is a bare `string` (`28`) while `SDKSystemMessage.apiKeySource` is the
  closed `ApiKeySource` union (`4860`) — one concept, two typings.
- `ApiKeySource`'s `'none'` explicitly includes OAuth, bearer-token and third-party-cloud auth
  (`124-126`); it does not mean "unauthenticated".
- `ThinkingEnabled.budgetTokens` is optional in the declaration (`8230`) though the option's own JSDoc
  example renders it required (`1728`).
- `Settings.availableModels` uses the empty array to mean "only the default model" (`5578-5580`), not
  "no models".
- `contextWindow`/`maxOutputTokens` are pinned on `ModelUsage` (per request), not on `ModelInfo` (per
  catalog row).
