# Protected runtime store bootstrap construction seam

This slice extends the existing concrete SDK session store and production embedded
entrypoint. It does **not** enable confined guest execution, implement a native
ownership adapter, or prove VM cold continuity. `supportsConfinedGuestExecution`
remains false and the startup guard still refuses before settings/providers/stores.
The CLI delegates to the embedded entrypoint but has no serialized bootstrap door.
A future protected guest supervisor must inject the capability inside its own realm.

The trusted supervisor calls `createProtectedStoreBootstrap(scope, ownershipPort)`.
The immutable scope binds workspace, logical root conversation, guest incarnation,
disk lease epoch, canonical durable store root and current kernel boot ID. Missing
ownership adapter is `native_owner_unavailable`. The object is registered in a
WeakMap; JSON, structured clones, SDK model options and environment variables cannot
recreate it. This capability checks trusted dependency plumbing, not signatures or
native OS evidence. The trusted native adapter itself must authenticate host facts,
bind actual store/disk filesystem identity, exclude concurrent processes/realms, and
independently establish prior guest termination plus exclusive store tenancy.
No production adapter ships here. SyntheticOwnershipPort in the tests is only a
deterministic adapter double; its JS Map is **not** cross-process exclusion.

`runEmbeddedSession` acquires the protected owner before store resolution. Both
`resolveEngineSession`'s root store and the child-factory store use the acquired
capability. Descendants already inherit that same concrete child store. Stores
assert active scoped ownership for keyed operations and filter sibling session
listings. All child subpaths remain under the owning logical root conversation;
the normal child execution factory still validates ancestry, roster/project binding,
current definitions and restrictions. No parallel transcript/store format is added.

The same concrete store's `runOwnedDurableOperation` guards the existing provider
state sinks (root and child), permission/hook journals, approval store and auto
counters. Construction reads, cached reads and writes all check the trusted scope
and owner. These guards decorate the existing implementations and retain their
files/formats; direct legacy file APIs do not gain a new global authority registry.
Guarded hook-audit reading is available through its explicit trusted guard argument.
The scope's operation admission counter covers asynchronous methods through promise
settlement. A release request closes new admission; an admitted pending operation
produces `retained / durable-operations-pending`, keeps the native hold, and is allowed
to settle. This introduces no drain or timer. Only a later explicit recovery/release
attempt after settlement can obtain the native teardown acknowledgement and release.
Post-release root/child sidecar methods refuse rather than recreating files.

Scoped top-level initialization requires an explicit logical session ID and eagerly
claims its writer lease even when fresh. Implicit continue, top-level conversation
forking, and cross-conversation resume are unimplemented on this seam and refuse.
This does not disable ordinary, specialized, nested or forked subagents belonging to
the admitted root; tests restore nested and forked histories through SendMessage.

Linux stale locks still bind PID, boot ID and process start ticks. An old-boot lease
is recovered only when the trusted owner supplies structured termination evidence
matching the complete current scope, owner token and exact prior boot ID. Missing,
false, mismatched or corrupt evidence never grants takeover. Legacy unidentified
leases remain refused because their distinct native recovery protocol is absent.
The existing generic SDK stale-lock rename race remains unchanged: concurrent
stale acquirers can both report success. The native protected owner protocol is a
mandatory prerequisite for using this seam across processes; a per-capability
single-use guard supplies only in-realm lifetime hygiene.

The owner stays held until the actual root runtime returns after its existing
descendant drain. Scoped cleanup failures propagate a trusted uncertainty observer
through descendant generations without changing legacy cancellation/drain behavior.
No new timeout releases ownership, and no new foreground-child sweep is introduced.
Missing/uncertain native teardown acknowledgement retains ownership and reports
recovery-required even when the agent turn succeeded. Only a structured acknowledgement
bound to scope/owner token and confirming stopped ownership permits release. The
native adapter must provide bounded shutdown and actual namespace/process cleanup
evidence; JS engine return alone cannot supply it. Pending cleanup keeps the runtime
pending and the owner retained. A thrown engine/cleanup path also retains ownership.
Tests cover pending descendant cleanup, rejected cleanup, and absent/uncertain
acknowledgement independently of normal completion. Native deadlines and recovery
outcomes remain a host/supervisor integration gate, not a claim of this slice.

The trusted supervisor must supply `onProtectedStoreOwnershipOutcome` whenever it
supplies a bootstrap capability; omission refuses before owner acquisition. The
observer fires exactly once after release handling with `{status, reason, scope}`.
Status is `released`, `retained`, `release-failed` or `not-acquired`; scope is the
immutable admitted scope, or null for an invalid/no requested capability. This is
the required lifecycle consumer contract: use the structured outcome to drive
bounded native shutdown/recovery and admission. Do not parse diagnostics or infer
ownership from the numeric turn exit code. The numeric API is preserved: a successful
turn may return 0 with retained ownership, while an exceptional startup can return
1 after a confirmed release or with retained/release-failed ownership. `completed`
means release completed, not that the user's task succeeded. Scope/teardown-proof
exceptions and failed acquisition rollback have explicit terminal outcomes.

Before production use, independently review the native cross-process protocol and
prove adapter authentication, lifetime revocation, directory identity binding,
same-conversation competing opens, reboot/recovery and bounded uncertain shutdown
on disposable Linux guests. No guest/model setting may supply termination evidence.
