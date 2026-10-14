# Private scoped host reader — source integration

This SDK source slice extends the existing prepared-query/current-context seam.
It changes no public exports, callback signatures, ordinary config bytes, native
entry, dependency pin, profile activation or release. Its base is reviewed wiring
`56e3ea6ab2dd7a0d3da6211b2fe62ce1adaa2c79` on the separate
`cowork/guided-host-reader` branch.

`packages/sdk/src/guided-query-reader.ts` supplies the internal
`readGuidedQueryInstructions(preparation, callbackSignal)` lookup. The host adapter
must retain its exact opaque preparation and capture the exact signal supplied to
that invocation of `onRuntimeContext`. A derived resolver signal, copied/proxied
signal or another preparation is not the same correlation. The protected reader
dependency can close over these values while the canonical Core resolver/mapping
checks continue to enforce workspace/backend/grant/owner relationships.

Only an active prepared parent context with the SDK's backend session and binding
can install the lookup. Children, foreign backend requests and ordinary unprepared
callbacks retain their existing callback behavior but have no reader handle. The
lookup accepts no paths, views, limits or arbitrary control subtype. One invocation
is allowed per context; callback completion, abort, preparation close or observed
transport exit removes it. Catching a failed read or returning before its read
settles cannot publish a successful cached context.

`query.ts` sends only the closed instruction-reader correlation DTO and owns a
separate typed pending map. IDs cannot collide with active incoming/control traffic
or be reused across this query's reader lifetime. Late replies are dropped rather
than offered to generic control settlement. The source bounds are 16 pending reads,
4096 consumed IDs per query and a 15-second wait; these are conservative source
bounds, not the unimplemented production generation-expiry ledger.

Neither preparation, signal identity, a matching UUID nor a returned JSON frame
grants native admission/read scope or proves cleanup. The actual admitted runtime
bridge and Root reader registration still select/enforce the isolated view and
require independent native reap/drain. The SDK checks bounded outer correlation;
the actual RuntimeSDK loader and existing Core mapper own snapshot semantics.

## Verification and remaining integration

With checkout-local workspace dependency links, the new scoped reader, existing
query lifecycle and complete runtime-context query suites pass: 42 tests and 307
assertions. That includes ordinary/specialized/forked child behavior, resume, host
failure with zero provider calls, cancellation/exit, malformed/cross-direction
traffic and callback signal identity. The new reader suite has eight tests, using
the actual SDK parser plus the real guided bridge/input router for a two-direction
permission/read wait. Its reader/owner effects are injected, not native evidence.

Package resolution was explicitly checked: SDK index and runtime testing resolve
to this worktree's `packages/sdk/src/index.ts` and `packages/runtime/src/testing.ts`.
The initial inherited cache instead resolved those packages into another worktree,
duplicating its tool registry and causing the child fixture to report zero children.
No source or oracle change was needed; local dependency links restored the full
ordinary query suite. External dependencies remain cached; no installation occurred.

Core's actual protected-reader callback must consume this internal handle and
perform its existing structured mapping/final canonical checks. Root's service,
immutable channel handoff, exact multi-origin packet and native execution evidence
remain separate. The base's Bun failure-disposal path must incorporate the separate
`9521ba12d6f564be018b4f3486e7d2b2fa5b50fa` conservative gate or pass the independently
reviewed actual pinned-Bun proof before runtime use. No C DATA patch was applied by
this slice; Mac two-disk/native-egress holds remain binding.
