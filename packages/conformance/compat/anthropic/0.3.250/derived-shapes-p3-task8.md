# P3 Task 8 derived shapes — task graph / cron / self-paced-wakeup result envelopes (pinned 0.3.250)

Authority for Task 8's own "envelope reconciliation via capture" MUST (task-8-brief.md): settling
`packages/runtime/src/tools/impl/task-graph.ts`'s TaskCreate/TaskGet/TaskList/TaskUpdate result
shapes, `cron.ts`'s CronDelete result shape, and `schedule-wakeup.ts`'s `scheduledFor` type and
`delaySeconds` bounds, against the pinned artifact. Mirrors `derived-shapes-p2.md`/
`derived-shapes-p3.md`'s own method and citation discipline in this same directory; nothing here
duplicates either file's own findings.

## Method

The pinned `@anthropic-ai/claude-agent-sdk@0.3.250` tarball was fetched via
`scripts/fetch-upstream.ts`'s `fetchAndVerifyUpstream()` (sha256 + npm registry sha512 integrity,
both checked against the committed `checksums.json` in this directory — both matched, unchanged
from P2/P3's own verification since this is the same pinned tarball), extracted with `tar` into a
second, independent `mkdtemp` directory, read in place across several passes (a first broad pass
across the whole tool-shape surface to orient which names exist at all; a targeted pass re-reading
the exact bodies of the nine interfaces this document cites; a final pass re-reading those same
nine bodies once more purely to record their line numbers for citation), and both the tarball
directory and the extracted directory were deleted in a `finally` block after every pass (one pass's
own cleanup call used the wrong field name from `fetchAndVerifyUpstream`'s return value and threw
before deleting — caught immediately from the thrown error, the two leftover directories were
identified via the OS tmpdir and deleted by a follow-up command before this task continued; no
tarball or extracted file was ever left in the repository itself, and a post-verification sweep of
the real OS tmpdir found no residue after that cleanup). No tarball, extracted file, or verbatim
excerpt was written to any persistent location. `bun run conformance:snapshot -- --check` was not
re-run by this task (no new symbol was added or removed from `sdk-tools.d.ts`'s own export
inventory; every shape below already existed in the pinned package before this task).

File examined: `sdk-tools.d.ts` only (4126 lines) — every shape below lives there. All line numbers
are **as published in the pinned tarball**, not any file in this repository.

**Naming discipline**: identical to P2/P3's own — the pinned identifier and field NAMES quoted below
are Winter's own naming (WS-03's compatibility posture, WS-07 §4). Every sentence of description,
every table, and this document's structure are original; nothing beyond individual pinned
type/field names and literal union members is quoted from the artifact.

**Claim provenance**: every shape below is a type-level fact directly evident from the declaration's
own code. `sdk-tools.d.ts` is a `json-schema-to-typescript`-generated file (confirmed during Lane 1's
own earlier capture pass, not re-verified here) — its interfaces are mechanical renderings of the
real upstream JSON Schema, not hand-written prose, so a field's presence/absence/type here carries
higher confidence than a human paraphrase would.

---

## Why this document exists: WS-06's own prose undercounted three wrapper keys

WS-06-tool-catalog.md §3.4 describes TaskCreate/TaskGet/TaskList's results in casual arrow-notation
("→ id/subject", "→ id, subject, description, status, blocks, blockedBy, or null", "→ compact rows
(...)") that never mentions an envelope wrapper key, even though each entry is marked `*(captured)*`.
The task-6 implementation (`task-graph.ts`) took this prose literally and returned bare, unwrapped
JSON for all three. This task's own brief named exactly one pair in this family as needing
"envelope reconciliation via capture" (TaskList's bare array vs. CronList's `{jobs}` wrapper); the
capture below, done to resolve that one named pair, incidentally resolved two more in the same
family that turn out to have the identical paraphrase gap (TaskCreate, TaskGet), plus two shapes
WS-06 states no result contract for at all (TaskUpdate, CronDelete), plus the named
`ScheduleWakeup` min/max-vs-clamp question. All six are reported together here since they were
found in one investigation of one tool family, not because the brief's own scope was reinterpreted
to reach beyond it.

---

## (a) `TaskCreateOutput`

**Source**: `sdk-tools.d.ts:3862-3867`.

```ts
interface TaskCreateOutput {
  task: {
    id: string;
    subject: string;
  };
}
```

**Finding**: wrapped under `task`. WS-06's own prose ("→ id/subject") omits the wrapper.

---

## (b) `TaskGetOutput`

**Source**: `sdk-tools.d.ts:3868-3877`.

```ts
interface TaskGetOutput {
  task: {
    id: string;
    subject: string;
    description: string;
    status: "pending" | "in_progress" | "completed";
    blocks: string[];
    blockedBy: string[];
  } | null;
}
```

**Finding**: wrapped under `task` in both the found and not-found branches — the not-found branch
is genuine JSON `{"task":null}`, not a bare `"null"` text token.

**Notable field fact**: the inner `status` union here has **three** members, omitting `"deleted"` —
contrast `TaskUpdateInput.status` (WS-06 §3.4 line 322 in this repo's own spec, itself
`*(captured)*`), which pins all **four** values including `"deleted"` as a settable input. Read
together with `TaskListOutput`'s own identical three-member status union (item (d) below) and
WS-06's explicit "`deleted` removes from listings" framing, a deleted row must be excluded from
**every** read surface, not just `TaskList`, for this union to be honored — `TaskGet` included.
`task-graph-store.ts`'s `listTasks` already implemented that exclusion; its `getTask` (the function
`TaskGet` itself calls) did not — a genuine gap this task fixes: `executeGet` (`task-graph.ts`) now
treats `row.status === "deleted"` identically to a nonexistent row, returning `{task: null}`,
so no read-side `status` field the executor emits can ever be `"deleted"`, consistent with the pin.
No change made to `TASK_STATUSES` (the four-value input enum) on the strength of this — it remains
pinned by WS-06's own separately-captured `TaskUpdate` input schema; only the two GET-shaped read
paths (`TaskGet`, `TaskList`) are affected.

---

## (c) `TaskUpdateOutput`

**Source**: `sdk-tools.d.ts:3878-3887`.

```ts
interface TaskUpdateOutput {
  success: boolean;
  taskId: string;
  updatedFields: string[];
  error?: string;
  statusChange?: {
    from: string;
    to: string;
  };
}
```

**Finding**: WS-06 §3.4 pins TaskUpdate's *input* schema verbatim but states no result contract at
all for it. The task-6 implementation filled that gap by mirroring `TaskGetOutput`'s own pinned
6-field shape (an advisor-endorsed choice, explicitly flagged in `task-graph.ts`'s own header
comment as "the closest already-pinned sibling shape, reused rather than inventing a new one from
nothing"). This capture supersedes that guess with the real, previously-unknown shape.

**Behavioral implication, not just a wire-shape one**: `taskId` and `error` are both **unconditional
enough to survive a failed update** (`taskId` has no `?` at all; `error` is present exactly on
failure) — meaning the pinned tool reports domain-level update failures (not-found,
self-reference, unknown-reference) as an ordinary, non-erroring tool result carrying
`success: false`, not as a tool-call-level failure. Winter's own implementation is changed to match:
`executeUpdate` in `task-graph.ts` now returns `{success:false, taskId, updatedFields:[], error}`
with `isError` unset for these three domain failures, while input-*shape* failures (missing/
malformed `taskId` itself, an invalid `status` enum value, a malformed `addBlocks` array — all
caught before a `TaskUpdateInput` can be constructed) remain `isError:true`, since a call that never
resolved to a real `taskId` has nothing to echo back in a `{success, taskId, ...}` shape at all.

**Two fields with no pinned behavioral detail** (`sdk-tools.d.ts` carries no field-level doc
comments on this interface, unlike `ScheduleWakeupOutput`'s — see (h)/(i) below): `updatedFields`
and `statusChange` are shape-only pins; their exact semantics are judgment calls, recorded rather
than silently invented:
- `updatedFields` reports the **result row's own field names** (`blocks`, `blockedBy`) rather than
  the input's verb-prefixed parameter names (`addBlocks`, `addBlockedBy`), on the reading that the
  field describes what changed on the row, not which input keys a caller happened to pass.
- `statusChange` is emitted only when `status` was part of the input **and** the resulting value
  differs from the row's prior value — the more conservative of two readings the bare field name
  supports (the other being "present whenever `status` was part of the input, regardless of whether
  it actually changed anything").

---

## (d) `TaskListOutput`

**Source**: `sdk-tools.d.ts:3888-3896`.

```ts
interface TaskListOutput {
  tasks: {
    id: string;
    subject: string;
    status: "pending" | "in_progress" | "completed";
    owner?: string;
    blockedBy: string[];
  }[];
}
```

**Finding**: this is the pair the brief named directly. Wrapped under `tasks`, not a bare array.
WS-06's own prose ("→ compact rows (...)") omits the wrapper, in contrast to its neighboring
CronList entry ("→ jobs with id/cron/...", which does name a wrapper word) — the same paraphrase gap
as (a)/(b) above, not evidence that TaskList was ever genuinely unpinned.

---

## (e) `CronCreateOutput`

**Source**: `sdk-tools.d.ts:4090-4095`.

```ts
interface CronCreateOutput {
  id: string;
  humanSchedule: string;
  recurring: boolean;
  durable?: boolean;
}
```

**No divergence**: matches the existing `cron.ts` implementation exactly, including `durable`'s
`?` (omitted from the wire result when the job was created non-durable). Recorded for completeness
since it was captured in the same pass as (f)/(g) below, not because anything needed to change.

---

## (f) `CronDeleteOutput`

**Source**: `sdk-tools.d.ts:4096-4098`.

```ts
interface CronDeleteOutput {
  id: string;
}
```

**Finding**: bare `{id}` — no `deleted` boolean. WS-06 §3.4 pins CronDelete's *input* only (`{id:
string}`, "by id only, never by expression"); task-6's own honest, explicitly-flagged guess for the
unpinned result was `{id, deleted}`, echoing whether a job with that id actually existed. Fixed to
drop `deleted` in every branch (found, not-found, in-memory, durable). The underlying *behavior* is
unchanged — deleting an unknown id is still not a tool-call error, matching the "by id is a lookup,
not an existence assertion" reading WS-06's own prose already supports — but the wire result now
carries no found/not-found signal at all, matching the pin. A caller that needs to know whether a
given id existed before deleting it must check via `CronList` first; Winter must not invent a field
beyond the pin to restore that lost signal.

---

## (g) `CronListOutput`

**Source**: `sdk-tools.d.ts:4099-4108`.

```ts
interface CronListOutput {
  jobs: {
    id: string;
    cron: string;
    humanSchedule: string;
    prompt: string;
    recurring?: boolean;
    durable?: boolean;
  }[];
}
```

**No divergence**: matches the existing `cron.ts` implementation's field set exactly. Winter emits
`recurring`/`durable` unconditionally where the pin marks them optional — emitting an optional field
is a valid realization of "optional," not a divergence from it. Recorded for completeness (this was
the other half of the brief-named TaskList/CronList pair — confirming CronList's own prose-vs-pin
match was accurate all along, unlike TaskList's).

---

## (h) `ScheduleWakeupInput`

**Source**: `sdk-tools.d.ts:2815-2836`.

```ts
interface ScheduleWakeupInput {
  /** Seconds from now to wake up. Clamped to [60, 3600] by the runtime. Required unless `stop` is true. */
  delaySeconds?: number;
  /** One short sentence explaining the chosen delay. [...] Required unless `stop` is true. */
  reason?: string;
  /** The /loop input to fire on wake-up. [...] Required unless `stop` is true. */
  prompt?: string;
  /** Set to true to end the dynamic loop immediately [...] */
  stop?: boolean;
  /** true = nothing changed [...] Required unless `stop` is true. */
  noop?: boolean;
}
```

(Doc comments above are restated/truncated per this document's own naming discipline — condensed to
the load-bearing clause only, not quoted in full.)

**Finding — the brief's named "min/max-vs-clamp" question, resolved**: `delaySeconds` carries **no
JSON-Schema `minimum`/`maximum`** at the type level — the `[60, 3600]` bound exists *only* as a
doc-comment description of **runtime** behavior ("Clamped to... by the runtime"), not a
schema-enforced constraint. This exactly matches `schedule-wakeup.ts`'s own executor, which already
clamps (`Math.min`/`Math.max` against `MIN_DELAY_SECONDS = 60`/`MAX_DELAY_SECONDS = 3600`) rather
than rejecting out-of-range input. The **unreachable** half the brief refers to was
`descriptors/schedule-wakeup.ts`'s own `inputSchema`, which declared `minimum: 60, maximum: 3600` —
an addition beyond the pin that put the advertised schema in tension with the executor's own
clamp-not-reject behavior (a schema-validating caller could reject a value the executor was always
going to accept-and-clamp). Fixed by removing the descriptor's `minimum`/`maximum`; the runtime
clamp is now the only enforcement, matching the pin exactly.

---

## (i) `ScheduleWakeupOutput`

**Source**: `sdk-tools.d.ts:3930-3951`.

```ts
interface ScheduleWakeupOutput {
  /** Epoch ms timestamp when the next wakeup will fire */
  scheduledFor: number;
  /** Actual delay used after clamping to runtime bounds */
  clampedDelaySeconds: number;
  /** True if the requested delaySeconds was outside [60, 3600] */
  wasClamped: boolean;
  /** True when the model ended the loop via `stop: true` */
  stopped?: boolean;
  /** How many pending dynamic-loop wakeups stop:true cancelled. [...] */
  cancelledWakeups?: number;
}
```

**Finding**: `scheduledFor` is a **number** (epoch milliseconds), not the ISO-8601 string
`schedule-wakeup.ts` previously produced via `Date.prototype.toISOString()`. Fixed to
`Date.now() + clampedDelaySeconds * 1000` directly, with no string conversion.

**No divergence on the disjoint-branch shape**: all five fields live on one type with `stopped`/
`cancelledWakeups` optional — consistent with the executor's own two-mutually-exclusive-branch
design (schedule branch never sets `stopped`/`cancelledWakeups`; stop branch never sets
`scheduledFor`/`clampedDelaySeconds`/`wasClamped`), which remains unchanged and is not a divergence
from "optional" fields on a single type.

---

## Notes recorded but not treated as Open Questions

- `TaskCreateInput`/`TaskUpdateInput`'s own pinned shapes were not re-captured here (WS-06 §3.4's
  own prose already gives verbatim input schemas for both, unlike the result shapes this document
  is about); this document is scoped to *result* envelopes only.
- The `TaskGetOutput`/`TaskListOutput` three-member `status` union (item (b)) was cross-checked
  against `TaskUpdateInput`'s own four-member pinned union rather than raising a fresh Open
  Question, since WS-06's own already-pinned "`deleted` removes from listings" behavior fully
  explains the asymmetry (see item (b) above).
- This document's own scope is the six shapes the brief's "envelope reconciliation" MUST and its
  immediate family touch (TaskCreate/TaskGet/TaskList/TaskUpdate/CronDelete/ScheduleWakeup). It does
  not extend the same fresh-capture treatment to the rest of the WS-06 §3 tool surface (Bash, Edit,
  Read, Write, NotebookEdit, Glob, Grep, Monitor, EnterPlanMode/ExitPlanMode, EnterWorktree/
  ExitWorktree, TaskOutput/TaskStop, the MCP-namespace tools, etc.) — those already have WS-06's own
  prose as their primary authority, and a from-scratch re-derivation of the entire tool surface's
  wire shapes is a materially larger undertaking than this task's own named scope. Given this
  document establishes that WS-06's prose paraphrase can drop a wrapper key even on entries marked
  `*(captured)*` (three separate times, in one family alone), a follow-up sweep applying this same
  ephemeral-capture check to the rest of the tool surface is a reasonable next task to schedule, not
  something this task silently expanded into.
- During the same investigation, ephemeral capture was cross-checked against all five descriptors
  in `packages/runtime/src/tools/descriptors/` that self-describe as carrying a "placeholder"
  schema: `tool-search.ts`, `wait-for-mcp-servers.ts`, `structured-output.ts`,
  `list-mcp-resources-tool.ts`, `read-mcp-resource-tool.ts`. These five are placeholders for three
  distinct, non-interchangeable reasons, not one: `ToolSearch`/`WaitForMcpServers` are placeholders
  because their own header comments assign contract ownership to a **different** workstream
  ([WS-09]) outright, regardless of what any artifact contains; `StructuredOutput` is placeholder
  **by design** — its own header states the real schema is generated per-call from a caller's
  requested output shape, so no static interface could ever replace it; `ListMcpResourcesTool`/
  `ReadMcpResourceTool`'s own header comments give the narrowest reason of the three ("Schema not
  pinned **verbatim by WS-06 §3**" — a claim about this repo's own spec prose, not about the
  upstream artifact). An exhaustive grep of every `.d.ts` file in the pinned tarball found zero
  occurrences of `ToolSearch`, `WaitForMcpServers`, or `StructuredOutput` anywhere — consistent with
  the first two reasons regardless of artifact contents, and with the third having nothing to find
  in principle. The same grep, by contrast, found real, fully-specified `ListMcpResourcesInput`/
  `Output` and `ReadMcpResourceInput`/`Output` interfaces in `sdk-tools.d.ts` — confirming their own
  header comments' narrower claim precisely ("not pinned verbatim **by WS-06**" is true; "no schema
  exists in the upstream artifact" would not have been). This is recorded as a finding for
  `conformance.test.ts`'s own correct-absence fixtures to encode faithfully (all five remain
  legitimate placeholders in Winter's registry, for the reasons above, not a "set of five to shrink
  to three") — it does not imply any executor-level or descriptor-level fix here: the schema
  [WS-09] eventually pins for the two MCP-resource tools is that workstream's own call to make, out
  of scope for this WS-06/WS-12 close-out task.
