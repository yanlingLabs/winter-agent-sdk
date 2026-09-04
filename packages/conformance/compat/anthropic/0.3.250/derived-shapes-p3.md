# P3 derived shapes — background-task message family (pinned 0.3.250)

Authority for Phase-3 Task 2's (WS-06 §3.5) field-level shapes: the six closed `SdkMessage`
variants `ctx.emitFrame` (packages/runtime/src/tools/registry.ts) accepts, added to
`packages/sdk/src/protocol/frames.ts`. Mirrors `derived-shapes-p2.md`'s own method and citation
discipline in this same directory; nothing here duplicates that file's own P2 findings.

## Method

The pinned `@anthropic-ai/claude-agent-sdk@0.3.250` tarball was fetched via
`scripts/fetch-upstream.ts`'s `fetchAndVerifyUpstream()` (sha256 + npm registry sha512 integrity,
both checked against the committed `checksums.json` in this directory — both matched, unchanged
from P2's own verification since this is the same pinned tarball), extracted with `tar` into a
second, independent `mkdtemp` directory, read in place across three passes (an initial broad grep
across all six `.d.ts` files for the seven tokens named in this task's own brief, a follow-up pass
resolving whether "ambient" is its own message type, and a final pass capturing the full,
untruncated body of `SDKLocalCommandOutputMessage` and the `UUID` type import), and both the
tarball directory and the extracted directory were deleted in a `finally` block after every pass.
No tarball, extracted file, or verbatim excerpt was written to any persistent location; a
post-verification sweep of the real OS tmpdir found no residue. `bun run conformance:snapshot --
--check` was not re-run by this task (no new symbol was added or removed from the six `.d.ts`
files' own export inventory — every shape below already existed in the pinned package before this
task; this task only reads them for the first time).

File examined: `sdk.d.ts` only (8448 lines is the same page count P2 cites — the tarball is
unchanged) — every shape below lives there; `sdk-tools.d.ts`/`bridge.d.ts`/`browser-sdk.d.ts` were
spot-checked for the seven brief-named tokens and had no independent hits beyond one incidental,
unrelated prose mention of "task_started" in `sdk-tools.d.ts`'s own `workflowName` field comment
(§ (a) below). All line numbers are **as published in the pinned tarball**, not any file in this
repository.

**Naming discipline**: identical to P2's own — the pinned identifier and field NAMES quoted below
are Winter's own naming (WS-03's compatibility posture, WS-07 §4). Every sentence of description,
every table, and this document's structure are original; nothing beyond individual pinned
type/field names and literal union members is quoted from the artifact.

**Claim provenance**: every fact below is a type-level fact — directly evident from the
declaration's code (no `@default`/doc-asserted behavioral claim is load-bearing for this task's own
shapes, unlike several of P2's).

---

## (a) The six shapes' membership in the top-level `SDKMessage` union

**Source**: `sdk.d.ts:4399`, the full `SDKMessage` union declaration (39 members — corrected from
"41" in the P4 fix wave, KNOWN (5); re-counted by splitting that single declaration line on `|` in
an ephemeral re-extraction of the same verified tarball, which was deleted immediately afterwards).
All six shapes
this task pins appear there as **direct, top-level members** — never nested inside another
variant's field — confirming each is independently discriminable on its own `.subtype`, the same
guarantee the hook trio (P2) already established for its own three members.

Incidental: `sdk-tools.d.ts:4061`'s own `workflowName` field comment on an unrelated tool-input
type reads "same value as task_started.workflow_name" — prose evidence corroborating
`SDKTaskStartedMessage.workflow_name` (item (b) below) rather than a shape of its own.

---

## (b) `SDKTaskStartedMessage`

**Source**: `sdk.d.ts:4959-4993`.

```ts
type SDKTaskStartedMessage = {
  type: 'system';
  subtype: 'task_started';
  task_id: string;
  tool_use_id?: string;
  description: string;
  subagent_type?: string;      // doc-asserted: subagent type, for Task-tool subagents
  is_backgrounded?: boolean;   // doc-asserted: background (true) vs. foreground-blocking (false) at registration
  spawn_depth?: number;        // doc-asserted: nesting depth of a spawned subagent task only
  task_type?: string;
  workflow_name?: string;      // doc-asserted: meta.name from the workflow script, only when task_type is 'local_workflow'
  prompt?: string;
  skip_transcript?: boolean;
  ambient?: boolean;           // doc-asserted: housekeeping task the CLI hides from activity indicators
  uuid: UUID;
  session_id: string;
};
```

No divergence to record against — this shape is newly pinned by this task, not asserted verbatim
anywhere in WS-06 before now.

---

## (c) `SDKTaskNotificationMessage`

**Source**: `sdk.d.ts:4915-4935`.

```ts
type SDKTaskNotificationMessage = {
  type: 'system';
  subtype: 'task_notification';
  task_id: string;
  tool_use_id?: string;
  status: 'completed' | 'failed' | 'stopped';
  output_file: string;
  summary: string;
  usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
  skip_transcript?: boolean;
  ambient?: boolean;
  uuid: UUID;
  session_id: string;
};
```

**Notable field-presence fact**: `usage` is **optional** here — contrast item (e) below, where the
structurally identical `{total_tokens, tool_uses, duration_ms}` shape is **required** on
`SDKTaskProgressMessage`. A real field-presence difference between the two sibling shapes, not a
transcription slip.

---

## (d) `SDKTaskUpdatedMessage`

**Source**: `sdk.d.ts:4995-5012`.

```ts
type SDKTaskUpdatedMessage = {
  type: 'system';
  subtype: 'task_updated';
  task_id: string;
  patch: {
    status?: 'pending' | 'running' | 'completed' | 'failed' | 'killed' | 'paused';
    description?: string;
    end_time?: number;
    total_paused_ms?: number;
    error?: string;
    is_backgrounded?: boolean;
  };
  uuid: UUID;
  session_id: string;
};
```

**Notable field-absence fact**: `patch` has no `ambient` field — of the four task-lifecycle shapes
(b)/(c)/(d)/(e), only (b) and (c) carry `ambient`; a task's ambient/housekeeping status is therefore
pinned only at start and at completion-notification time, never as something `task_updated` can
retroactively flip. See the DEVIATION note in (g) below for why this matters to this task's own
brief.

---

## (e) `SDKTaskProgressMessage`

**Source**: `sdk.d.ts:4937-4957`.

```ts
type SDKTaskProgressMessage = {
  type: 'system';
  subtype: 'task_progress';
  task_id: string;
  tool_use_id?: string;
  description: string;
  subagent_type?: string;
  usage: { total_tokens: number; tool_uses: number; duration_ms: number };  // REQUIRED — see (c)
  last_tool_name?: string;
  summary?: string;
  uuid: UUID;
  session_id: string;
};
```

No `ambient` field (see (d)'s own note — only two of the four task-lifecycle shapes carry it).

---

## (f) `SDKBackgroundTasksChangedMessage`

**Source**: `sdk.d.ts:3173-3190` (doc comment `3170`-`3172`).

```ts
type SDKBackgroundTasksChangedMessage = {
  type: 'system';
  subtype: 'background_tasks_changed';
  tasks: {
    task_id: string;
    task_type: string;
    description: string;
    ambient?: boolean;
  }[];
  uuid: UUID;
  session_id: string;
};
```

**Doc-asserted behavior** (`3171`, restated rather than quoted): this is a LEVEL signal, not an
edge — it carries the full set of currently-live background tasks, replace-semantics, emitted
whenever membership changes OR any entry's `ambient` flag flips; a host should swap its local set
for each payload rather than pairing it with `task_started`/`task_notification` as start/end
bookends, since a missed bookend would otherwise wedge a stale "is background work running"
indicator. Nothing is emitted at process startup — the set starts empty and repopulates from the
next real change (or from a snapshot sent right behind a repeated `initialize` control request on
an already-running process, per the same comment) — orthogonal to this task's own scope
(`ctx.emitFrame` from inside a tool executor), noted here only because it is visible in the same
type's own doc comment.

**NEAR-MISS** (recorded so a future reader never conflates the two — see this document's own (g)
below for the parallel "flag it" instruction this task's brief gives for the ambient deviation):
this `tasks[]` element shape is **not** the pinned standalone `BackgroundTaskSummary` type
(`sdk.d.ts:134-159`: `id: string; type: string; status: string; description: string; command?:
string; agent_type?: string; server?: string; ...`) that WS-08's own Stop/SubagentStop hook-input
tables cite (`derived-shapes-p2.md` item (b), P2) for their own `background_tasks?:
BackgroundTaskSummary[]` extra input field. The two describe "a background task" in prose but do
not share a field-naming scheme (`task_id`/`task_type` here vs. `id`/`type` there), and this
narrower shape has no `status`/`command`/`agent_type`/`server` fields at all. Same class of
same-source-domain-different-shape trap `derived-shapes-p2.md` flagged for
`SDKPermissionDenial`/`SDKPermissionDeniedMessage` — never treat one as interchangeable with the
other.

---

## (g) `SDKLocalCommandOutputMessage`

**Source**: `sdk.d.ts:4349-4355` (doc comment `4346`-`4348`).

```ts
type SDKLocalCommandOutputMessage = {
  type: 'system';
  subtype: 'local_command_output';
  content: string;
  uuid: UUID;
  session_id: string;
};
```

**Doc-asserted behavior** (`4347`, restated): output from a local slash command (the comment's own
two examples translate to "e.g. a voice-mode toggle or a usage-stats command"), displayed as
assistant-style text in the transcript. Unrelated in subject matter to (b)-(f) above — this is
slash-command output, not a background task — but pinned by this same task's brief alongside them;
this document follows the brief rather than re-scoping it, and `frames.ts`'s own
`BackgroundTaskMessage` union groups it into the same closed set `ctx.emitFrame` accepts since
nothing in WS-06 §3.5 or this declaration restricts that seam to task-shaped messages specifically.

---

## DEVIATION: "ambient" is a field, not a seventh message type

This task's own brief lists six frame names as if they were siblings — `task_started |
task_notification | task_updated | task_progress | background_tasks_changed | ambient` — grouped
with a seventh, `SDKLocalCommandOutputMessage`, described together as "the seven pinned shapes."

An exhaustive search of all six `.d.ts` files for `subtype: 'ambient'` and for any
`SDKAmbientMessage`/`AmbientMessage` type name returned **zero matches**. `ambient` exists only as
a plain `ambient?: boolean` field, present on exactly three of the shapes above — (b)
`SDKTaskStartedMessage` (`4990`), (c) `SDKTaskNotificationMessage` (`4932`), and each element of (f)
`SDKBackgroundTasksChangedMessage.tasks` (`3186`) — and absent from (d) `SDKTaskUpdatedMessage`'s
`patch` and from (e) `SDKTaskProgressMessage` entirely.

**Resolution** (per this task's own brief: "follow the DECLARATION — it is the authority — and flag
it in your report"): `packages/sdk/src/protocol/frames.ts` ships **six** named `SdkMessage`
variants below the hook trio, not seven. `ambient` is threaded through as a field on the three
shapes the declaration actually places it on; no `SDKAmbientMessage` type exists in this codebase.

---

## Notes recorded but not treated as Open Questions

No spec text is contradicted by either of these; recorded for completeness.

- `uuid`'s pinned type is `import type { UUID } from 'crypto'` (`sdk.d.ts:11`) — Node's own
  template-literal string type, not a nominal brand. All six shapes above keep the hook trio's own
  established `uuid: string` representation (Task 10, P2) rather than re-litigating a new one here.
- `usage`'s optional-vs-required split between `SDKTaskNotificationMessage` and
  `SDKTaskProgressMessage` (items (c)/(e)) is a real, deliberate-looking asymmetry in the pinned
  declaration (a notification can legitimately have no usage to report — e.g. a `'stopped'` status
  before any work happened — while a progress update, by definition, only fires once some usage
  already exists) rather than an inconsistency to paper over.
