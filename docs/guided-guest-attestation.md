# Guided guest attestation: the guest ticket

**Status: dormant source.** Nothing in the SDK claims the issuer or mints a ticket.
`query()` can only *spend* one. With no own property named `guidedGuestTicket`, every guided
and non-guided path behaves exactly as before this change, with the same error and the same
ordering (the one addition is a single own-property descriptor read of that name, observable
only to a `Proxy` trap on the options object, the same class of observability the existing
`Reflect.has` posture check already has). Nothing here activates a guest, admits a native
owner, or touches the runtime binary or its data.

## What it is

Until now a guided query (`Options.guidedQueryPreparation`) refused
`executionPosture: "confined-guest"` unconditionally, because nothing in the process could
say "this launch belongs to the host that owns the workspace". The guest ticket is that
statement:

> The owning host mints a private "this launch is mine" ticket that no outside code can
> create. The SDK re-checks it at every step. Each ticket works once and dies when the
> workspace restarts, tracked by counters rather than a clock.

A guided query may run as `confined-guest` only when it presents a valid, unspent,
current-generation ticket bound to *that* preparation. A ticket is lifecycle and
correlation state. It is **not** native admission, kernel evidence, or filesystem
authority: the host's owner slot, the runtime's compartments and the guest entry still
enforce those, and the real runtime still refuses to start a guest without them. In
particular the runtime's own entry (production wiring and the engine) refuses a config
that carries both `requiredRuntimeContext` and `executionPosture: "confined-guest"`, and
this change does not touch it: even with a valid ticket, no real guest starts today.

## The parts

| Part | Where | Rule |
|---|---|---|
| Issuer | `claimGuidedGuestIssuer()` (the one package export) | Claimable once per **module instance**. Every later claim throws. Only the issuer mints, advances, revokes and forgets. |
| Ticket | `GuidedGuestTicket` (type only; no class or constructor is exported) | A frozen null-prototype object recorded in a module-private `WeakMap`. Spread, clone, JSON, `Proxy`, `Object.create` and prototype tricks are not tickets. `toJSON` throws. |
| Generation | per workspace key, inside the module | `(incarnationId, leaseEpoch)` plus an open flag. Only moves forward by `advance`. |
| Guard | `guided-query-preparation.ts` (internal) | One guard per preparation, bound at mint. Every correlation step asks it whether the generation is still current. |
| Spend | `query()` (internal import only) | Consumes the ticket atomically before the claim. |

The issuer's whole surface:

```ts
const issuer = claimGuidedGuestIssuer();            // once; keep it private
issuer.advance(workspaceKey, incarnationId, leaseEpoch);   // announce / move a generation
const ticket = issuer.mint({ workspaceKey, incarnationId, leaseEpoch, preparation });
issuer.revoke(workspaceKey);                        // kill everything now, refuse mints until a higher epoch
issuer.forget(workspaceKey);                        // revoke, then free the counter slot (workspace gone for good)
query({ prompt, options: { ...pair, guidedQueryPreparation: preparation, requireRuntimeContext: true,
  executionPosture: "confined-guest", guidedGuestTicket: ticket } });
```

`mint` never moves a counter: the workspace must already have announced exactly
`(incarnationId, leaseEpoch)` through `advance` (and not be revoked), and the preparation
must be a genuine, still-prepared one with no ticket yet (one ticket per preparation, ever).

## Ticket lifecycle

`minted` -> `spent` (by `query()`) -> `dead`; or `minted` -> `dead`. There is no way back.

* **Minted.** Bound to workspace, incarnation, lease epoch and one preparation. The
  preparation now carries a guard.
* **Spent.** `query()` spends it *before* claiming the preparation. After any presentation
  of a genuine ticket whose checks fail, it is dead too (wrong preparation, stale
  generation, bad shape, a refusal later in `query()` setup). A replay of a spent ticket is
  refused. Presented with a *different* preparation it leaves the running query alone;
  presented with the *same* preparation it closes it, as any second `query()` on one
  preparation does.
* **Dead.** The preparation closed (normal end, abort, exit, `closeGuidedQuery`), or the
  generation advanced, or `revoke`/`forget` ran, or the ticket was retired by a failed
  presentation.

## The gate in `query()`

Guided + `confined-guest` is allowed only when all of these hold; otherwise it throws
`required_context_unavailable` and closes the presented preparation, as before:

1. `guidedGuestTicket` is an own data property holding a genuine ticket. An own accessor
   with that name is refused (even for a local query) and never read; an inherited value
   is ignored and so is today's refusal.
2. The posture is exactly `"confined-guest"`. A ticket with any other posture is refused
   and spent.
3. The ticket is unspent, bound to this preparation, and its generation is current.

These stay refused regardless of any ticket:

* `hostCodeProcessBroker` with `confined-guest` (it still throws its own message, after the
  ticket was spent);
* the host-code delegation denial inside the broker handlers (unreachable while the line
  above holds, kept as defence in depth);
* non-guided `requireRuntimeContext` with `confined-guest` (a ticket is not even consulted
  without `guidedQueryPreparation`).

## Re-check at every step

Every `preparation.assert(...)` in `query.ts` (the post-spawn check, the instruction read
request and its answer, both context-handler checks, the first-iteration check) dispatches
to `assertGuidedQueryCorrelation`, and the guided reader's scope checks use it too. The
generation check lives there, in one place. Beyond those sites a guest query also checks
before the host's spawn hook, at claim, and at the correlation consume. If the generation
is no longer current the guard closes the record exactly as `closeGuidedQuery` does
(context disposers run, the callbacks are released) and the step fails as
`required_context_unavailable`.

## A revoked guest's other traffic is gated too

Closing the context door is not enough: a stale guest's other frames must not reach the
consumer or a host callback. Once the ticket is revoked (the generation moved, or
`revoke`/`forget` ran, or a stale generation was found while running; an ordinary process
exit is **not** a revocation, so a finished guest's last frames still arrive):

* every frame the runtime sends, of any type, ends the query with
  `required_context_unavailable` before it is dispatched or yielded: no `assistant` or
  `result` frame reaches the consumer;
* when the stream ends after a revocation the query throws instead of returning on a
  terminal result that was already seen (a revocation beats `sawTerminal`);
* no control-request handler runs (`permission`, `hook`, `sdk_mcp_call`, elicitation, the
  reader, credentials, host messaging, ...): the request is answered
  `required_context_unavailable`;
* a handler that was already running when the generation died is not allowed to answer: its
  result (or its thrown error) is replaced by the same refusal, so a late `allow` is never
  delivered. The in-flight host callback itself still finishes; only its answer is dropped.

## Expiry by counters, never a clock

`advance(workspaceKey, incarnationId, leaseEpoch)`:

* the first call for a key announces its generation;
* the same pair again is a no-op (it does not reopen a revoked workspace);
* a **strictly higher `leaseEpoch`** moves the generation (the incarnation id may repeat or
  change); it is installed *before* anything is torn down;
* a lower epoch, or the same epoch with another incarnation id, is refused and applies
  nothing;
* ids must match the host's id text shape and the epoch must be a positive safe integer.

A move kills every unspent ticket of that workspace and every running query bound to an
older generation. "Kills" here means: the ticket is dead, the preparation is closed
(readers aborted, later steps fail), the running query asks for the SDK's existing
`TERM`/`KILL`-grace child teardown (stdin end, one `TERM`, `KILL` after the grace), and
its remaining traffic is gated as above. Errors thrown by that host teardown never stop the
loop over other queries. The module has no `Date`, no timer and no TTL (a pin test asserts
that on the source).

`revoke(workspaceKey)` does the same kill without moving a counter and also closes the
generation: no mint is accepted, and nothing bound to it is current, until a strictly higher
epoch is announced. It is idempotent and a no-op for a key that was never announced.
`forget(workspaceKey)` revokes and then frees the counter slot, for a workspace that is gone
for good; announcing the same key again starts a new history, so use it only for keys that
will not be reused. No dead ticket can come back either way.

Counters are in memory. They are monotonic for the life of the module instance, until
`forget`; a restart starts empty, and so does every ticket, so no ticket survives a restart.

## Mapping to the host's values

The host (Core) canonical values this is built for:

* `workspaceKey` = the canonical workspace id.
* `leaseEpoch` = the workspace row's lease epoch. Core increments it at every
  `beginIncarnation`, so it is the **monotonic counter**.
* `incarnationId` = the workspace row's incarnation id. It is an **opaque identity text,
  not an order** (Core generates a fresh one per incarnation). The SDK compares it for
  equality and orders only by `leaseEpoch`.
* The per-session backend generation and the guest boot id are *not* part of the ticket;
  the host's owner slot compares them on every lookup.

## Bounded state

`GUIDED_QUERY_CORRELATION_CAPACITY` (4096) bounds three tables:

* live ticket records (unspent or running; released when the preparation closes or the
  generation dies);
* workspace counters (dropped only by `forget`, because a counter that could be lost by
  accident could regress);
* the process-global consumed-binding set. Correlation ids consumed by a guest-ticket
  preparation are also remembered against their workspace generation and **leave the set
  when that generation dies** (`advance` to a higher epoch, `revoke`, `forget`), so the
  4096 cliff is not permanent per process. Ids consumed with no ticket are never evicted.
  This is safe because each query still compares the id it consumed with the one it
  generated, so a replayed id fails there even without the set; the set is the earlier of
  two layers.

At capacity a mint, or a first announcement of a new workspace, is refused; known
workspaces keep advancing. A cliff inside one long-lived generation (4096 guided queries in
a single incarnation) still refuses every further claim until that generation ends.

## Threat model

**Boundary.** Everything here is an in-process capability inside one module instance. The
trusted side is the code that claims the issuer and the code that calls `query()` with the
result. The guest is a separate process and cannot reach any of it.

**What it gives (data-forgery resistance).** A value that merely has the right shape is
refused: object literals, spreads, `Object.assign`, `structuredClone`, JSON round trips
(`toJSON` throws), `Proxy` wrappers, `Object.create(ticket)`, frozen copies, primitives, a
preparation passed as a ticket, a ticket from another module instance, a ticket minted for
another preparation, a ticket whose workspace moved on, and a ticket used a second time.
Request objects to `mint` are read as closed own-data shapes, so no caller getter or trap
runs.

**One per module instance.** The issuer, the ticket table and `query()` that spends tickets
live in the same module instance. A second copy of the SDK (another version, the source and
the built output, a Worker that loads its own) has its own issuer, its own tables and its
own `query()`: it can claim its own issuer, but a ticket never crosses between copies, so a
ticket minted by one copy is refused by the other. A guest query must run in the copy that
minted its ticket.

**What it does NOT defend against.**

* Code in the same module instance's realm that runs *before* the host claims the issuer.
  The claim is first-come: it cannot authenticate who calls it. If other code claims first,
  the host's own claim throws (it fails closed) but the other code holds the issuer.
* Code that tampers with intrinsics (`WeakMap.prototype.get/set`, `Map.prototype.get/set`,
  `Set.prototype`, `Object.getOwnPropertyDescriptors`, `Reflect`, ...), **before or after
  this module loads**. The module looks them up at call time and, like the existing
  preparation module, does not capture pristine copies, so patching one later defeats it
  just as patching one earlier does.
* A debugger, the inspector or any code that can read the issuer or the module's closure.
* A buggy or malicious host: the SDK trusts `advance` to carry canonical values and
  cannot read the database. A host that never calls `advance` keeps old tickets valid.
* Cross-process or cross-restart replay protection: tickets are process memory.
* Native proof. No ticket establishes an owner, a kernel fact, a view, or a file.

## How it is pinned

* `guided-guest-attestation.test.ts` is the only suite that claims the real issuer (the
  claim is once per module instance and `bun test` shares one registry); the bounded-state
  and consumed-id cliff tests run a separate process (`fixtures/guided-guest-ticket-capacity.ts`).
* `guided-guest-attestation-wiring.test.ts` is a TypeScript AST scan over **every**
  `.ts/.tsx/.mts/.cts/.js/.mjs/.cjs` file under `packages/` and `scripts/` (not only `src`).
  No file is exempt by name: the exact claimers are listed, so a file named `*.fixture.ts`
  or `*.test.ts` that claims fails. It checks the single package export, an exact importer
  allowlist with exact names, that the SDK entry is never taken whole (no star re-export,
  default import, escaping namespace, enumeration or computed or concatenated key, no
  `then`, no rest destructuring), a run-time-built module specifier only where one exists
  today, no clock or class in the module, and it carries negative controls proving the scan
  catches each wiring shape.

## Integration pins for the later Core wiring

Not done here (no issuer is wired); recorded so the activation PR gets them right:

1. **Claim the issuer as the first act of daemon boot** on the winter-core main thread, as
   a process singleton, and fail boot if the claim throws. `query()` for guest sessions runs
   on that thread; embedded Workers never claim (their own module instance would have an
   issuer that no main-thread ticket matches).
2. **Call `advance` at every incarnation start, before any mint** for it. `advance` is the
   only way a generation exists; `mint` refuses an unannounced pair.
3. **`draining`:** stop minting; do not advance.
4. **`uncertain`:** do not advance until it is resolved, and call `revoke(workspaceKey)` so
   outstanding tickets and running queries die now; the workspace then stays closed until
   the next higher epoch is announced.
5. **Deleted workspaces:** call `forget(workspaceKey)` so the counter slot and the
   consumed ids are freed.
6. **Epoch lower bound: the SDK wins.** Core's provider broker accepts `leaseEpoch >= 0`,
   but this module requires `>= 1` for every `advance` and `mint`. Epoch 0 means no
   incarnation has ever begun, so no guest can be live; the host must not announce or
   mint at 0, and if it does the SDK refuses (fail closed). A broker lookup that tolerates
   0 is a different door and is not a reason to relax this one.

## Open items for the owner

1. **First-come issuer claim.** It cannot tell a legitimate daemon from earlier code in the
   same realm. Integration pin 1 narrows it (claim first); the alternatives are to accept it
   (the realm is the trust boundary) or to move minting into a separately loaded, reviewed
   bootstrap.
2. **Incarnation is an identity, not a counter.** The brief called for an incarnation
   counter; the host has none, only the lease epoch. Confirm that `leaseEpoch` is the
   canonical order and the integration pins above.
3. **Teardown scope.** `advance`/`revoke`/`forget` ask running queries for the existing
   `TERM`/`KILL`-grace child teardown and gate their remaining traffic, not only close
   preparations. A revoked query whose child dies between assert sites surfaces to the
   consumer as `required_context_unavailable` (the per-frame gate) or, if the process dies
   first, as the existing "unexpected process death" error.
4. **Consumed-binding set.** Ids leave it when their generation dies, but one generation that
   consumes 4096 ids still hits the cliff. Raising or sizing it is a separate decision.
5. **Not bound by the ticket:** backend generation and boot id. They remain the owner
   slot's job.
6. **Preparation-level guard.** The guard is attached at mint, so a preparation with a
   ticket is generation-bound even if it is later run locally without presenting it.
7. **Redundant layers.** The generation is checked at spend, claim, spawn, consume, every
   assert, per frame and by eager revocation. Several layers overlap on purpose; the
   mutation notes in the PR say which alone are equivalent.
8. **Activation.** This only lifts the SDK-side host guard. Wiring a real issuer, owner
   evidence, the runtime and compartments, and any native change are separate approvals.
