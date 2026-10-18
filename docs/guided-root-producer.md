# Guided Root producer and entry: source only

Root (the guest supervisor, `packages/runtime/src/guest/linux-supervisor.py`) can now produce
the `host-query-guided-v1` bootstrap record, and a guided entry
(`packages/runtime/src/guest/linux-guided-host-query-main.ts`) calls the existing
`admitGuidedHostQueryLinuxSession` factory. Nothing is activated: no consumer, packet, compile
entry, launcher or release references the entry, the SDK host guard still refuses every confined
required-context query, and no native code was changed or run. A record that the guest validators
accept is DATA. It admits no owner, serves no reader and starts no provider.

## What Root now emits

Profile selection stays Root's own. Exactly one of the top-level keys `freshRuntime`,
`hostQueryRuntime` or `hostQueryGuidedRuntime` in the trusted config FD selects the profile
(`select_runtime_profile`); two keys refuse with `runtime_profile_conflict`, and each conversation
may carry only the selected key. Tool requests, admin requests and `RuntimeConfig`-style JSON can
never select it: the admin socket still accepts only `{operation, sessionId}`, and a `profile`,
`readerRegistration`, `runtimeConfig`, `registrationId`, `owner`, `views` or `limits` key inside a
runtime entry refuses with `runtime_config`.

A guided conversation entry takes the v1 fields plus two explicit, plain Root-config inputs:

- `requiredRuntimeContext`: the SDK's closed `{version: 1, bindingId}`, `bindingId` a lowercase UUID v4.
- `generation`: a positive safe integer. Root does not choose or age it (see the open decisions).

`guided_host_query_config` is the unchanged v1 `host_query_config` plus `requiredRuntimeContext`.
`guided_reader_registration` builds the closed registration the guest validators parse:

| Field | Value |
| --- | --- |
| `registrationId` | minted by Root per configured runtime with `uuid.uuid4()` |
| `owner` | workspace, logical session, backend session, incarnation and lease epoch from the admitted authority; `bootId` from Root's guest boot; the explicit `generation` |
| `views` | `sourceRoot` = `sourceCwd` = the first root (the v1 `cwd`); `sharedRoot` `/run/winter/shared-instructions`; `sharedPath` ending in `WINTER.md` |
| `limits` | exactly `maxFileBytes` 131072, `maxReadBytes` 262144, `maxReadOccurrences` 256, `maxExpandedBytes` 131072 |
| `requiredRuntimeContext` | the same correlation the config carries |

Root refuses early what the guest validators would refuse later: a lease epoch of 0 (Root's
`authority()` accepts it, the guest and native owner do not), a malformed boot ID, a source root that
is not exactly `/workspace/folders/<id>` or `/workspace/repos/<id>` (v1 admits deeper paths), and a
config/registration correlation mismatch.

`_runtime_record` adds `profile`, `readerRegistration` and a `runtimeConfig` carrying
`requiredRuntimeContext` for the guided profile only. The v1 and fresh records, and their four
descriptors, are byte-identical to `origin/main` (pinned by a golden test).

The native owner receives a fifth descriptor for guided only. `_run_runtime` creates an
`AF_UNIX`/`SOCK_STREAM` socketpair, sends the guest end as the fifth `SCM_RIGHTS` descriptor in the
same envelope as the four v1 descriptors (`bootstrap_rights` is the one place the count is decided),
and closes Root's copy of the guest end after the send. Root keeps its own end open until the run
ends: the native owner polls the stream for `POLLRDHUP` on every check, so closing it would lose the
owner. **Nothing serves that end in this slice**, so a read request from a guided runtime would never
be answered. It does not shut the stream down or write to it.

## The guided entry

`linux-guided-host-query-main.ts` mirrors `linux-host-query-main.ts`: the same fixed
`--native-bootstrap-fd 3 --native-owner-fd 4` argument check, then
`admitGuidedHostQueryLinuxSession(3, 4)`. The reader channel is the fifth descriptor of the bootstrap
envelope, claimed natively by the admission factory, never a numbered argument. It must never call
the v1 or fresh factory; a static test pins that, and that no other file references the entry. The
entry is deliberately not in the `scripts/guest-host-query` packet or compile lists, which would change
compile pins. The comment in `linux-session-admission.ts` saying that no current entry, producer or
public SDK export calls the guided factory is now stale by exactly this one unpackaged source file. It is
left unedited on purpose: that module is a compile input of the v1 host-query entry, so even a comment
edit would change the v1 compile inputs and their pins.

## What stays refused

- **The host guard.** `packages/sdk/src/query.ts` still throws `required_context_unavailable` for a
  prepared or required-context query with `executionPosture: "confined-guest"` (the two checks near
  lines 815-830 and 982), except for a guided query that presents a one-shot guest ticket minted by the
  owning host's issuer (`guided-guest-attestation.md`). No SDK path mints a ticket, so nothing lifts it
  today. A source pin test keeps the gated text in place.
- **The reader service.** Root serves nothing on the stream. Producing a registration does not
  authenticate it natively (the C patch checks the stream's creator, not the later holder), and Root's
  exclusive per-incarnation handoff, framed reader service and drain evidence are still owed
  (`guided-session-wiring-continuation.md`, items 3 and 7).
- **The guidance view.** The owner-approved compartment C patch is applied
  (`guided-guidance-view-matrix.md`): for a guided conversation with a `guidanceDirectory`, the tool
  launcher mounts `/run/winter/shared-instructions` read-only and the `/workspace/.winter/WINTER.md`
  alias. Without that Root key nothing is mounted. The reader service, a native admission and any
  hosted or live run are still owed; `sharedPath` remains a validated string for the SDK.
- **The engine.** Without a native admission the guest engine fails closed: a test runs the guided
  config through `runEmbeddedSession` with no and forged admissions and sees exit 1, no store
  acquisition and no output, so no provider is reached.
- **Everything native and live.** No native owner, VM, reader, hosted or compile run.

## Open decisions

Two decisions (together "F2") gate any activation of the guided profile, and a third item is a separate
prerequisite for both.

1. **Whether and how the `query.ts` guard is lifted.** The SDK host still refuses every confined
   required-context query. What evidence a future change must require before lifting that refusal
   (an actual native owner admission of the five-descriptor record, a served and drained reader, a
   mounted guidance view), and where the lift sits, is undecided. Nothing in this slice moves it. The SDK
   side is now the dormant guest ticket (`guided-guest-attestation.md`); the evidence a host must hold
   before it mints one is still undecided.
2. **Generation expiry and replay policy.** Root takes `generation` as an explicit positive integer and
   enforces no expiry, rotation or replay ledger. Whether Root mints it, ages it out, and how a consumed
   registration or binding is refused after a restart is the open production policy
   (`guided-session-wiring-continuation.md`, item 6). A fixed value would be a placeholder, not a
   policy, which is why the input is explicit.

Separate prerequisite, also undecided: **correlation delivery**. Today `requiredRuntimeContext` is a
plain input in Root's trusted config. How a prepared query's `{version: 1, bindingId}` reaches Root
before bootstrap creation (the hook-to-Root transport) is out of scope here; the SDK's preparation and
claim lifecycle and its 4096-entry consumed-ID set are source prerequisites, not that transport.

## Tests

- `packages/runtime/src/guest/linux-guided-producer.test.ts`: the actual Python producer's output is
  accepted by the guided config, roots and registration validators in all six host modes; the owner
  matches the scope including generation, boot and lease; exact limits; five descriptors for guided
  and four for v1 and fresh; a v1/fresh golden; validators refusing a missing registration, mismatched
  correlation, zero generation or lease; JSON, tool and admin input unable to select the profile; the
  engine failing closed; static pins for the entry, the unwired file and the host guard.
- `scripts/guest-supervisor/test_guided_host_query.py`: the pure builders, the real
  `_configure_runtime`, `_runtime_record` and `_run_runtime` send path with an injected process and
  selector (the fifth descriptor and the reader stream's ownership), profile conflicts including the
  service constructor, and a full v1/fresh golden. CI runs it in the `guest-file-boundary` job, which
  previously ran only `test_protocol.py` from this directory.
