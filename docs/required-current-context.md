# Required current instruction context

The runtime engine has an opt-in, trusted `SystemPromptAssembler.requiredContext`
dependency. It resolves the current instruction layer before every main generation
and each compaction provider dispatch, after host-input and tool-planning waits.
Tool continuations and engine fallback retries resolve again. A fit-check compaction
also discards the prepared snapshot before the next main dispatch.

The source returns bounded plain text with separate host facts and applicable
instructions, plus a diagnostic revision. It cannot return tools, permissions,
hooks, settings or executable trust. No revision or instruction text grants
authority; the host must enforce grants separately when actions execute.

```ts
const requiredContext = {
  async resolve(request, { signal }) {
    // Bind session/agent/cwd to current host records; these are lookup inputs,
    // never authorization. Load guest repository files inside the guest view.
    return { revision: "workspace:7", facts: hostFacts, instructions: currentText };
  },
};
```

The host opts in programmatically, including through
`createSystemPromptAssembler({ requiredContext })`. The dependency is not a
serialized `RuntimeConfig` option or a saved child snapshot. Existing child
factories pass their current assembler to ordinary, specialized and forked child
generations. A restarted host must supply the resolver again from current
authority. A product requiring this layer must refuse admission when it cannot
bind that dependency; absence preserves ordinary Code behavior.

When opted in, the resolver owns the complete instruction layer, including user
guidance and any applicable memory index. The engine suppresses the cached
`claudeMd` entry structurally and does not discover it through the normal assembler.
This prevents stale or duplicate guidance from a generated run home or inherited
fork layout. Other base context, history, tools and persona remain as before.
Place host facts in a separate dynamic system block and editable instructions in
the normal live `claudeMd` user-context framing, once. Diagnostic revisions stay
outside model text, avoiding cache churn when only provenance changes. Capture only the base
layout for forks and compaction prefixes. Do not persist the live layer as history
or authoritative continuation state. Historical model replies remain history.

The resolver receives engine identity, live cwd, purpose, attempt and a cancellation
signal. Its default deadline is 15 seconds, configurable between 1 ms and 30 seconds.
Normal resolution should complete in less than a second; the deadline is a failure
ceiling, not expected latency on every tool round. An idle compaction control uses
the session's operation signal, never an aborted prior turn's signal.
The rendered layer is capped at 128 KiB. Malformed results, host errors, unavailable
guidance, cancellation or deadline prevent that dispatch, with path-free typed
`required_context_*` failures and no stale fallback. The callback must validate
current binding and authority after its own asynchronous reads. Files can change
without a policy revision, so an unchanged revision must not reuse stale bytes.
This is a per-request snapshot, not an atomic multi-file filesystem transaction.

The router's guidance-only loader can supply current text using its normal
filename, order and import semantics. It must run in the source-owning filesystem
under the admitted guest view. Shared/source instructions must reach this layer
once; rebuilding executable run-home settings is not a guidance refresh.

This component does not admit a `runtime_context` RPC, serialize callbacks over
`query()`, register confined guest children or widen existing Linux admission
profiles. Those are separate integration and review work. Advisor, classifier,
WebFetch digest and other auxiliary model calls are not covered by this main-loop
and compaction seam. No VM, cold process-restoration, production availability or
consumer pin claim follows from the scripted engine tests.
