# Guided guest attestation: the guest ticket

**Status: dormant source.** Nothing in the SDK claims the issuer or mints a ticket.
`query()` can only *spend* one. With no ticket, every guided and non-guided path behaves
exactly as before this change, with the same error and the same ordering. Nothing here
activates a guest, admits a native owner, or touches the runtime binary or its data.

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
| Issuer | `claimGuidedGuestIssuer()` (the one package export) | Claimable once per module instance. Every later claim throws. Only the issuer mints and advances. |
| Ticket | `GuidedGuestTicket` (type only; no class or constructor is exported) | A frozen null-prototype object recorded in a module-private `WeakMap`. Spread, clone, JSON, `Proxy`, `Object.create` and prototype tricks are not tickets. `toJSON` throws. |
| Generation | per workspace key, inside the module | `(incarnationId, leaseEpoch)`. Only moves forward by `advance`. |
| Guard | `guided-query-preparation.ts` (internal) | One guard per preparation, bound at mint. Every correlation step asks it whether the generation is still current. |
| Spend | `query()` (internal import only) | Consumes the ticket atomically before the claim. |

Issuer methods (the whole surface):

```ts
const issuer = claimGuidedGuestIssuer();            // once; keep it private
issuer.advance(workspaceKey, incarnationId, leaseEpoch);
const ticket = issuer.mint({ workspaceKey, incarnationId, leaseEpoch, preparation });
query({ prompt, options: { ...pair, guidedQueryPreparation: preparation, requireRuntimeContext: true,
  executionPosture: "confined-guest", guidedGuestTicket: ticket } });
```

`mint` never moves a counter: the workspace must already have announced exactly
`(incarnationId, leaseEpoch)` through `advance`, and the preparation must be a genuine,
still-prepared one with no ticket yet (one ticket per preparation, ever).

## Ticket lifecycle

`minted` -> `spent` (by `query()`) -> `dead`; or `minted` -> `dead`. There is no way back.

* **Minted.** Bound to workspace, incarnation, lease epoch and one preparation. The
  preparation now carries a guard.
* **Spent.** `query()` spends it *before* claiming the preparation. After any presentation
  of a genuine ticket whose checks fail, it is dead too (wrong preparation, stale
  generation, bad shape, a refusal later in `query()` setup). A replay of a ticket another
  running query already spent is refused and leaves that query alone.
* **Dead.** The preparation closed (normal end, abort, exit, `closeGuidedQuery`), or the
  generation advanced, or the ticket was retired by a failed presentation.

## The gate in `query()`

Guided + `confined-guest` is allowed only when all of these hold; otherwise it throws
`required_context_unavailable` and closes the presented preparation, as before:

1. `guidedGuestTicket` is an own data property holding a genuine ticket (accessors and
   inherited values are never read).
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

## Expiry by counters, never a clock

`advance(workspaceKey, incarnationId, leaseEpoch)`:

* the first call for a key announces its generation;
* the same pair again is a no-op;
* a **strictly higher `leaseEpoch`** moves the generation (the incarnation id may repeat or
  change); it is installed *before* anything is torn down;
* a lower epoch, or the same epoch with another incarnation id, is refused and applies
  nothing;
* ids must match the host's id text shape and the epoch must be a positive safe integer.

A move kills every unspent ticket of that workspace and every running query bound to an
older generation. "Kills" here means: the ticket is dead, the preparation is closed
(readers aborted, later steps fail), and the running query asks for the SDK's existing
`TERM`/`KILL`-grace child teardown (stdin end, one `TERM`, `KILL` after the grace). Errors
thrown by that host teardown never stop the loop over other queries. The module has no
`Date`, no timer and no TTL (a pin test asserts that on the source).

Counters are in memory. They are monotonic for the life of the module instance; a restart
starts empty, and so does every ticket, so no ticket survives a restart.

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

`GUIDED_QUERY_CORRELATION_CAPACITY` (4096) bounds both tables: live ticket records (unspent
or running; released when the preparation closes or the generation moves) and workspace
counters (never deleted, because a counter that could be forgotten could regress). At
capacity a mint, or a first announcement of a new workspace, is refused; known workspaces
keep advancing. The existing process-global consumed-binding set is unchanged (see open
items).

## Threat model

**Boundary.** Everything here is an in-process capability inside one JS realm. The trusted
side is the code that claims the issuer and the code that calls `query()` with the result.
The guest is a separate process and cannot reach any of it.

**What it gives (data-forgery resistance).** A value that merely has the right shape is
refused: object literals, spreads, `Object.assign`, `structuredClone`, JSON round trips
(`toJSON` throws), `Proxy` wrappers, `Object.create(ticket)`, frozen copies, primitives, a
preparation passed as a ticket, a ticket from another module instance (a second copy of
the SDK, a Worker's own instance), a ticket minted for another preparation, a ticket whose
workspace moved on, and a ticket used a second time. Request objects to `mint` are read as
closed own-data shapes, so no caller getter or trap runs.

**What it does NOT defend against.**

* Code in the same realm that runs *before* the host claims the issuer. The claim is
  first-come: it cannot authenticate who calls it. If other code claims first, the host's
  own claim throws (it fails closed) but the other code holds the issuer.
* Code that tampers with intrinsics (`WeakMap.prototype`, `Set.prototype`,
  `Object.getOwnPropertyDescriptors`, `Reflect`, ...) before this module loads. The module,
  like the existing preparation module, does not capture pristine copies.
* A debugger, the inspector or any code that can read the issuer or the module's closure.
* A buggy or malicious host: the SDK trusts `advance` to carry canonical values and
  cannot read the database. A host that never calls `advance` keeps old tickets valid.
* Cross-process or cross-restart replay protection: tickets are process memory.
* Native proof. No ticket establishes an owner, a kernel fact, a view, or a file.

## How it is pinned

* `guided-guest-attestation.test.ts` is the only suite that claims the real issuer (the
  claim is once per module instance and `bun test` shares one registry); the bounded-state
  test runs a separate process.
* `guided-guest-attestation-wiring.test.ts` is a TypeScript AST scan: only tests claim,
  the single package export, an exact importer allowlist with exact names, no clock or
  class in the module, and negative controls proving the scan catches each wiring shape.

## Open items for the owner

1. **First-come issuer claim.** It cannot tell a legitimate daemon from earlier code in the
   same realm. Options: claim before any other module loads; accept as is (the realm is the
   trust boundary); or move minting into a separately loaded, reviewed bootstrap.
2. **Incarnation is an identity, not a counter.** The brief called for an incarnation
   counter; the host has none, only the lease epoch. Confirm that `leaseEpoch` is the
   canonical order, that the host calls `advance` at every `beginIncarnation`, and what
   `draining` and `uncertain` power states do to outstanding tickets.
3. **Teardown scope.** `advance` asks running queries for the existing `TERM`/`KILL`-grace
   child teardown, not only for closed preparations. Confirm that is wanted.
4. **Consumed-binding set.** It still holds 4096 entries per process and never evicts, so a
   long-lived daemon can claim at most 4096 guided queries before every claim fails closed.
   Evicting safely needs its own reviewed protocol; ticket records are bounded by *live*
   count, not lifetime count.
5. **Not bound by the ticket:** backend generation and boot id. They remain the owner
   slot's job.
6. **Preparation-level guard.** The guard is attached at mint, so a preparation with a
   ticket is generation-bound even if it is later run locally without presenting it.
7. **Redundant layers.** The generation is checked at claim, spawn, consume, every assert
   and by eager revocation. Several layers overlap on purpose; the mutation notes in the PR
   say which alone are equivalent.
8. **Activation.** This only lifts the SDK-side host guard. Wiring a real issuer, owner
   evidence, the runtime and compartments, and any native change are separate approvals.
