# Required current context over query transports

`Options.requireRuntimeContext: true` and a host-local `Options.onRuntimeContext`
callback opt a query into the dedicated `runtime_context` control RPC. Both are
required together. The SDK serializes only a versioned binding descriptor;
callbacks, instruction text and host authorization objects are never placed in
`RuntimeConfig`. The runtime advertises version 1 in its internal init handshake.
A missing callback, missing feature, malformed response, disconnected adapter or
failed lookup refuses current-context dispatch. There is no cached Code fallback.
Ordinary queries without the opt-in keep their existing config and handshake bytes.

The callback receives a closed, bounded lookup request: `bindingId`, `sessionId`,
optional `agentId`, live `cwd`, `purpose` (`generation` or `compaction`), and positive
bounded `attempt`. Its separate `trustedQuerySessionId` comes from the owning
SDK query configuration, never the guest init frame or request. The host must
bind that query to its canonical backend registration and independently authorize
the current session, descendant agent and source roots before reading guidance.
In a resumed query, the requested session can differ from the newly allocated
query identity; the host must resolve that relationship from canonical state.
Neither a string agent identity nor a matching nonce proves child ownership.
The nonce prevents transport mixups; it is not workspace or grant authority.
Caller JSON cannot supply Cowork/project/grant fields through this schema.

The response contains exactly `revision`, `facts` and `instructions`. Revision is
bounded diagnostic provenance, not an authority token. Facts and editable guidance
remain distinct; together they have a 128 KiB UTF-8 limit. The engine also checks
the final rendered context bound. Exceptions are normalized to fixed context
failure codes without forwarding callback text, paths or credentials. Each actual
model/compaction dispatch resolves a current snapshot. The existing engine timeout
aborts the correlated RPC; runtime cancellation and query teardown reach the host
callback's `AbortSignal`. Hosts must honor cancellation to stop their own work.
Late responses cannot provide a fallback snapshot.

Production wiring creates one channel per query and binds it once to the parent's
existing control bridge. Ordinary, specialized and forked children share that
parent-owned source through their assembler; child engines never overwrite its
bridge. Parent teardown closes the channel and cancels pending context requests.
A new query creates a new descriptor/channel. Child execution snapshots contain
neither callbacks nor the descriptor/nonce, so restored generations use current
host wiring rather than a persisted transport. In-process SDK tests verify the
query parser, runtime adapter and three child types. A temporary transcript is
written, the first virtual runtime exits, and a second store resolves that durable
session and loaded assistant history with a fresh channel. This is in-process
filesystem resume evidence, not a native/process/VM cold restart or admission.

The current confined Linux/fresh/host-query profiles remain unavailable for this
opt-in. The SDK refuses it with `executionPosture: "confined-guest"`; runtime wiring
and engine entry also refuse that combination before native admission. Their
closed profile/config/tool rules and disabled child factory remain unchanged.
A Cowork guest RPC profile, canonical host revision/authorization, protected native
filesystem view, actual child admission and transport integration require separate
review and execution evidence. This source seam does not enable them or prove VM
isolation, cold continuation, release or consumer pinning.
