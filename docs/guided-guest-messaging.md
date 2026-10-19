# Guest messaging: coordination tools, host answers and the held-input journal (GM1, GM2)

Source: N2 extensions design section 4 (`docs/research/2026-10-18-n2-extensions-design.md` on the winter repo, branch
`cowork/n2-extensions-design`). This is the agent-SDK half. Nothing here makes a Cowork session creatable.

## GM1: tools, host messaging, host answers

- **Tool set.** The host-query profile now admits a closed set of eleven tools: `Read`, `Write`, `Edit`, `Bash` and the seven
  coordination tools `SendMessage`, `ListAgents`, `AskUserQuestion`, `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate`
  (`LINUX_HOST_QUERY_TOOLS`). `TaskStop` and `TaskOutput` are withheld (O10): the guest has no background tasks or subagents to stop,
  and guest Bash refuses `run_in_background`. The registry's confined-guest gate (`tools/registry.ts`) is the same closed set; Grep, Glob,
  NotebookEdit, Workflow, LSP and every other tool keep `guest_tool_unsupported`.
- **`hostMessaging`.** A new config key, allowed only as `true` and only beside `SendMessage` or `ListAgents`.
- **Supervisor.** `host_query_config` gains a `coordinate` tool class (up to four classes now). It offers the seven coordination tools and sets
  `hostMessaging: true`. Without it nothing changes (no new key, no new tool), so existing configs are byte-identical. `AskUserQuestion` rides
  the `coordinate` class rather than every config; the host decides who may answer it.
- **Frames and subtypes, changed together.** The bridge's `allowedSubtypes` for BOTH host-query profiles gains `host_message_send` and
  `host_message_list` (never `host_session_stop`), and `checkLinuxHostQueryFrame(frame, ownsPermission, ownsHostRequest)` now accepts the
  host's answer to a request the runtime issued, checked against the closed answer shape of THAT request (send vs list). Changing only the
  subtypes would have made every answer a drop and every call fail at its request timeout. The two call sites pass the predicate:
  `checkLinuxSessionFrame` (both profiles) and the one caller in `engine.ts` (`hostMessageRequestKind(bridge)`). An answer for an id nobody
  owns is still dropped; a malformed answer for an owned id is refused.
- Nothing goes over mux class 3; messaging rides the runtime's class-2 stream as ordinary control frames.

## GM2: the held-input journal

The runtime keeps a durable journal of host inputs that are HELD (invisible to the model, undecided), COMMITTED (part of the conversation,
reaching the transcript exactly once) or IN_TRANSCRIPT (a tombstone). It lives beside the transcript
(`<store>/projects/<project>/<session>/held-inputs.json`), under the store-lease guard, and every change is a temp file, fsync, rename and
directory fsync before the call returns; a failed write leaves memory and disk unchanged.

| Verb (host -> runtime) | Effect | Answer |
|---|---|---|
| `host_input_hold` | refuse an epoch that is not the admitted one; write a `held` record | `{held:true}`; same id and body: `{held:true, again:true}` with the token REPLACED; id already committed or in the transcript: `{held:false, state}`; another body: error `conflict` |
| `host_input_commit` | only a `held` record with exactly this token becomes `committed` (durably), then the input rides the conversation | `{outcome: folded \| queued \| started}`; already committed or in the transcript: `{outcome:"already"}`; another token: error `superseded`; no record AND not in the transcript: terminal `unknown_input` |
| `host_input_discard` | delete a `held` record with exactly this token | `{discarded:true}` (idempotent for an unknown id); another token: `{discarded:false, reason:"superseded"}`; committed or in the transcript: error `committed` |
| `host_input_forget` | delete an `in_transcript` tombstone with exactly this token | `{forgotten:true}` (idempotent); anything else `{forgotten:false}` |

- **Answered after the durable write.** A commit is answered only once the journal write is durable. The transcript write follows at the next
  point the SDK may add a user message: a folded input becomes a `queued_command` attachment carrying its `inputId`, a turn-start input a
  `user` entry whose `origin` is `{kind:"host-input", inputId}`. Only after the append does the journal record become `in_transcript`.
- **Restart.** Before `system/held_inputs` is emitted the journal is deduped against the transcript by `inputId` (a `held` or `committed` record
  already in the transcript becomes `in_transcript`), and every `committed` record the transcript does not hold is fed first, before any
  other input. A late `commit` for an id the journal has forgotten but the transcript holds is `already`, not `unknown_input`.
- **`system/held_inputs`** is emitted exactly once, ALWAYS (empty included), right after `init` and before the first input is read, listing each
  `held` record and each not-yet-appended `committed` record with its digest and token. Nothing held starts a turn until the host decides.
  `system/host_input_committed {inputId, outcome}` follows a commit.
- **`clearQueuedInput`** never drops, and never counts, a journal input.
- **Capability.** The runtime offers `held-input-v1` (`RUNTIME_EXECUTION_POSTURE_CAPABILITIES.capabilities`, `HELD_INPUT_CAPABILITY`). A host
  sends `host_input_*` only to a runtime that offers it: an older runtime's checker refuses an unknown control subtype and a refusal is a
  hard stop. The profile's frame checker admits exactly these four new subtypes with closed, size-bounded payloads (text at most 64 KiB).
- **Host verbs.** `Query.holdInput/commitInput/discardInput/forgetInput` (rejecting with a `WinterRpcError` carrying the runtime's code).
- A subagent never has a journal; a run without one (the local leg) neither emits `held_inputs` nor serves the verbs.

Tests: `held-input-journal.test.ts` (every transition, atomicity, durability order), `held-input-engine.test.ts` (the verbs against the real
engine, folding, queueing, clear, restarts), `held-input-failure-table.test.ts` (every row of the 4.5 failure table, with a model of the host's
ledger and `drainOnce` driving a real guest), `held-input-protocol.test.ts` (the frame checker, capability, the Query verbs, the wiring) and
`linux-host-query-messaging.test.ts` (GM1).

## Pins that move (image)

| Pin | Moves because |
|---|---|
| `linux-supervisor.py` sha256 | the `coordinate` class (delta recorded in `docs/research/guided-supervisor-guest-messaging-DATA.patch`) |
| `linux-session-admission.ts` (FROZEN in `test_guided_guidance_view.py`, the byte-identical check in `test_guided_reader_service.py`) | the predicate pass-through and `linuxSessionHeldInputEpoch` |
| the guest engine bundle (runtime `engine.ts`, `guest/linux-host-query-profile.ts`, `tools/registry.ts`, `store/dialect.ts`, `embedded.ts`, `guest/execution-posture.ts`, `guest/held-input-journal.ts`) | compiled into the guest engine; the compiled hashes follow the next compile run |
| the SDK (`packages/sdk`: `query.ts`, `options.ts`, `protocol/*`) | the new verbs, constants and message types; the host SDK pin follows |

The native owner library, fixture and matrix are untouched.
