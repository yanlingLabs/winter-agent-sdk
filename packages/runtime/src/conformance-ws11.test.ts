// Phase 5 Task 8 -- the WS-11 §10 fixture matrix.
//
// WS-11 §10 is written as "the [WS-17] harness MUST prove, at minimum:" followed by twelve bullets,
// each of which names several distinct obligations. This file is one ROW per obligation, and every
// row carries exactly one of three verdicts:
//
//   "covered"  -- a real test already proves it, cited by {file, testName}. The second describe block
//                 below READS each cited file and asserts the citation's substring is genuinely
//                 present, so a renamed or deleted cited test FAILS HERE rather than rotting in a
//                 comment.
//   "new"      -- a genuine gap this task closes directly, self-cited the same way (and subject to
//                 the self-citation guard below).
//   "deferred" -- out of scope at this phase, naming its owning phase and the EVIDENCE for the
//                 absence, never a silent omission.
//
// Zero rows may lack one of the three. The pattern, the guard and the machine-verification are
// `permissions/conformance.test.ts`'s (P2 T13) and `tools/conformance.test.ts`'s (P3 T8) verbatim;
// what is new here is the SPEC, not the mechanism.
//
// THIS FILE ASSERTS NOTHING ABOUT BEHAVIOUR ITSELF, deliberately. Table-driven here means "one row
// per spec obligation, one citation per row", not "re-prove the cited tests' assertions in a loop" --
// a second copy of an assertion is a second thing to keep in step with the implementation.
//
// HERMETIC: no upstream artifact is fetched. Every claim about the pinned runtime below is a
// transcription from `packages/conformance/compat/anthropic/0.3.250/derived-shapes-p5.md`, which was
// produced by an ephemeral capture in its own session; `bun test` never reaches the network.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface Citation {
  /** Path to the test file, relative to THIS file. */
  file: string;
  /** An exact, verbatim substring of a real `test(...)`/`describe(...)` title in that file. */
  testName: string;
}

interface ConformanceRow {
  id: string;
  spec: string;
  bullet: string;
  status: "covered" | "new" | "deferred";
  citations?: Citation[];
  owningPhase?: string;
  note?: string;
}

// ================================================================================================
// WS-11 §10, bullet by bullet.
// ================================================================================================

const WS11_10: ConformanceRow[] = [
  // --- bullet 1: the Workflow input schema and the pure-literal meta ------------------------------
  {
    id: "WS11-01a",
    spec: "WS-11 §10",
    bullet: "the exact Workflow input schema: all seven fields; >=1-of-three validation; `scriptPath` precedence; `description`/`title` ignored without error",
    status: "covered",
    citations: [
      { file: "./tools/impl/workflow.test.ts", testName: `at least one of script/name/scriptPath is REQUIRED` },
      { file: "./tools/impl/workflow.test.ts", testName: `\`args\`/\`description\`/\`title\`/\`resumeFromRunId\` alone do NOT satisfy the requirement` },
      { file: "./tools/impl/workflow.test.ts", testName: `\`scriptPath\` takes PRECEDENCE over both \`script\` and \`name\`` },
      { file: "./tools/impl/workflow.test.ts", testName: `\`script\` beats \`name\` when no scriptPath is given` },
      { file: "./tools/impl/workflow.test.ts", testName: `\`description\` and \`title\` are ACCEPTED AND IGNORED -- never an error, and never used as metadata` },
    ],
    note: "The seventh field, `args`, is covered by its own row (WS11-01c) rather than folded in here: it is the only one with a semantic beyond presence.",
  },
  {
    id: "WS11-01b",
    spec: "WS-11 §10",
    bullet: "pure-literal `meta` validation including phase-title matching",
    status: "covered",
    citations: [
      { file: "./workflows/meta.test.ts", testName: `REJECTS an identifier reference -- a computed value is not a literal` },
      { file: "./workflows/meta.test.ts", testName: `REJECTS a call expression` },
      { file: "./workflows/meta.test.ts", testName: `REJECTS a spread` },
      { file: "./workflows/meta.test.ts", testName: `REJECTS a template literal, interpolated or not` },
      { file: "./workflows/meta.test.ts", testName: `REJECTS an arithmetic expression` },
      { file: "./workflows/meta.test.ts", testName: `a phase() title matching a declared phase EXACTLY resolves to that declared group` },
      { file: "./workflows/meta.test.ts", testName: `an unmatched phase() call gets its OWN group rather than being dropped or folded into the last one` },
    ],
  },
  {
    id: "WS11-01c",
    spec: "WS-11 §10",
    bullet: "`args` reaches the script verbatim (the seventh input field)",
    status: "covered",
    citations: [
      { file: "./tools/impl/workflow.test.ts", testName: `\`args\` reach the script VERBATIM` },
      { file: "./workflows/script-api.test.ts", testName: `\`args\` is the WorkflowInput.args value VERBATIM -- real JSON values, never re-stringified` },
    ],
  },

  // --- bullet 2: resume ---------------------------------------------------------------------------
  {
    id: "WS11-02a",
    spec: "WS-11 §10",
    bullet: "resume: unchanged-prefix cache hits, first-divergence live re-run, failure non-caching",
    status: "covered",
    citations: [
      { file: "./workflows/script-api.test.ts", testName: `same script + same args = 100% cache hit: nothing is dispatched live` },
      { file: "./workflows/script-api.test.ts", testName: `the FIRST changed call and everything after runs live` },
      { file: "./workflows/script-api.test.ts", testName: `running past the journal's recorded end is a divergence too` },
      { file: "./workflows/script-api.test.ts", testName: `a cached call costs NOTHING against the total-agent cap -- it never spawned` },
    ],
  },
  {
    id: "WS11-02b",
    spec: "WS-11 §10",
    bullet: "resume preconditions: same-session, and the prior run must have been stopped",
    status: "covered",
    citations: [
      { file: "./tools/impl/workflow.test.ts", testName: `an unknown runId is a typed tool error` },
      { file: "./tools/impl/workflow.test.ts", testName: `a run that has not been STOPPED is refused, and the message names TaskStop` },
      { file: "./tools/impl/workflow.test.ts", testName: `resumeFromRunId alone satisfies the at-least-one rule -- the prior run supplies the source` },
      { file: "./workflows/store.test.ts", testName: `the JOURNAL root is session-TEMP, not the durable area -- resume is same-session-only by contract` },
    ],
  },
  {
    id: "WS11-02c",
    spec: "WS-11 §10",
    bullet: "`verify:workflow` staying green on the compiled binary",
    status: "new",
    citations: [{ file: "./conformance-ws11.test.ts", testName: `verify:workflow is a CI STEP, not merely a script that exists` }],
    note:
      "The gate itself is `scripts/verify-workflow.ts`, which compiles a real binary and drives a real workflow through its `__workflow-worker` argv dispatch -- a dispatch that exists only in the COMPILED entry graph, so no dev-leg run stands in for it. What T8 adds is making it a CI STEP (rider 8/21); the row below asserts that, because a gate nothing runs is not a gate.",
  },

  // --- bullet 3: script-environment guards ---------------------------------------------------------
  {
    id: "WS11-03a",
    spec: "WS-11 §10",
    bullet: "withheld `Date.now` / `Math.random` / argless `new Date`",
    status: "covered",
    citations: [
      { file: "./workflows/script-api.test.ts", testName: `Date.now() throws` },
      { file: "./workflows/script-api.test.ts", testName: `argless new Date() throws, but new Date(ts) works` },
      { file: "./workflows/script-api.test.ts", testName: `Math.random() throws, and the rest of Math still works` },
    ],
  },
  {
    id: "WS11-03b",
    spec: "WS-11 §10",
    bullet: "shadowed ambients",
    status: "covered",
    citations: [
      { file: "./workflows/script-api.test.ts", testName: `process / require / fetch / globalThis are all undefined in the body` },
      { file: "./workflows/script-api.test.ts", testName: `dynamic \`import()\` is REFUSED -- the one ambient that cannot be shadowed by a parameter name` },
      { file: "./workflows/script-api.test.ts", testName: `CLOSED: \`performance\` is shadowed` },
      { file: "./workflows/script-api.test.ts", testName: `CLOSED: \`crypto\` is shadowed` },
    ],
    note:
      "Three routes stay OPEN and are named `test.skip`s in that same file rather than hidden: `(function(){}).constructor` reaching the real `Function`, a runtime-CONCATENATED `import` token (invisible to a source-text scanner), and `Object.getPrototypeOf(new Date(0)).constructor` (closable only by mutating the shared `Date.prototype`, which an in-process-capable worker must not do). WS-11 §1.7 has always said the seatbelt is the enforcement boundary and scope shadowing is defence in depth; the disclosure is that the shadowing closes fewer routes than Lane W's first report claimed.",
  },
  {
    id: "WS11-03c",
    spec: "WS-11 §10",
    bullet: "the three caps (`min(16, CPUs-2)`, 1000, 4096) failing EXPLICITLY",
    status: "covered",
    citations: [
      { file: "./workflows/primitives.test.ts", testName: `\`min(16, CPUs - 2)\`, floored at 1` },
      { file: "./workflows/script-api.test.ts", testName: `concurrent agent() calls are bounded and the excess QUEUES` },
      { file: "./workflows/script-api.test.ts", testName: `the TOTAL agent cap is an explicit failure RECORDING THE COMPLETED COUNT -- never a silent truncation` },
      { file: "./workflows/script-api.test.ts", testName: `more than \`maxItemsPerCall\` items is an EXPLICIT error, never a silent truncation` },
      { file: "./workflows/script-api.test.ts", testName: `the cap DEFAULT is 4096` },
    ],
    note: "`min(16, CPUs-2)` is sourced from the live harness reference, NOT from the pin -- WS-11 §11 OQ1 says so and item (g) confirms the declaration is silent on all three caps. Recorded so the number is not later mistaken for pinned.",
  },
  {
    id: "WS11-03d",
    spec: "WS-11 §10",
    bullet: "the worker actually runs under the seatbelt, with the `~/.winter/run` read-deny",
    status: "covered",
    citations: [
      { file: "./sandbox/deny.darwin.test.ts", testName: `a sandboxed read of <home>/.winter/run/* is denied while a sibling path under the same home reads fine` },
      { file: "./sandbox/profile.test.ts", testName: `home renders a subpath deny for <home>/.winter/run` },
    ],
    note: "Darwin-gated by construction (`sandbox-exec`). Lane W's `workflows/worker.darwin.test.ts` carries the worker-specific probes; these two are the profile-level pair, cited because they are what makes the deny a property of the generated profile rather than of one probe.",
  },

  // --- bullet 4: skills ---------------------------------------------------------------------------
  {
    id: "WS11-04a",
    spec: "WS-11 §10",
    bullet: "skills: lazy body load",
    status: "covered",
    citations: [
      { file: "./skills/store.test.ts", testName: `the index carries name+description only; \`load()\` reads the CURRENT file, so a post-index edit is visible` },
      { file: "./skills/store.test.ts", testName: `\`load()\` byte-caps the body and reports a miss as null` },
    ],
  },
  {
    id: "WS11-04b",
    spec: "WS-11 §10",
    bullet: "skills: parent-walk discovery bounds",
    status: "covered",
    citations: [
      { file: "./skills/store.test.ts", testName: `findRepoRoot stops at the directory holding .git; roots are nearest-first from cwd up to it` },
      { file: "./skills/store.test.ts", testName: `with NO repository root above it, the walk covers cwd alone -- it never climbs to the filesystem root` },
      { file: "./skills/store.test.ts", testName: `a NEARER .winter/skills shadows a repo-root one of the same name` },
    ],
  },
  {
    id: "WS11-04c",
    spec: "WS-11 §10",
    bullet: "skills: `skills` list validation BEFORE spawn",
    status: "new",
    citations: [
      { file: "./skills/option.test.ts", testName: `an UNKNOWN name is a typed failure naming every unknown, not a throw` },
      { file: "./production-wiring.test.ts", testName: `an unknown name in \`skills\` is a WARNING, not a throw -- and the name never reaches the frame` },
    ],
    note:
      "The validator existed; what T8 adds is the CALL, in `production-wiring.ts`, before `runEngine` is entered on every leg -- which is what makes 'before spawn' true rather than available. An unknown name is surfaced as a warning rather than an abort: the pin's own behaviour for one is uncaptured (report §60 records only that the validation exists), and the names are dropped from the session's effective set either way, so the model is never told about a skill it cannot load.",
  },
  {
    id: "WS11-04d",
    spec: "WS-11 §10",
    bullet: "skills: automatic `Skill(...)` permission entries",
    status: "new",
    citations: [
      { file: "./skills/option.test.ts", testName: `a list produces one name-scoped rule per skill, in order` },
      { file: "./skills/option.test.ts", testName: `an empty list and an omitted option both produce NO entries` },
      { file: "./production-wiring.test.ts", testName: `\`withAutoSkillPermissions\` adds the BARE rule for the default, one per name for a list, and nothing when unset` },
      { file: "./skills/permission-rules.test.ts", testName: `a per-name allow rule ALLOWS its own skill -- the whole family was inert before the routing` },
    ],
    note:
      "TWO halves, and only the first existed. Lane S produced the rule STRINGS; T8 folds them into the session's `allowedTools` before the engine seeds its rule set (rider 21's companion), AND routes `Skill(...)` rules through `matchesSkillRule` in the evaluator (rider 18) -- without which every per-name entry compared against `\"\"` and silently never matched.",
  },
  {
    id: "WS11-04e",
    spec: "WS-11 §10",
    bullet: "skills: the tools-must-include-`Skill` rule",
    status: "covered",
    citations: [
      { file: "./skills/option.test.ts", testName: `a restricting \`tools\` list that omits Skill makes skills uninvocable, and the validation SAYS SO` },
      { file: "./skills/option.test.ts", testName: `the same list WITH Skill produces no warning` },
      { file: "./skills/option.test.ts", testName: `\`disallowedTools\` naming Skill is the OTHER way to make skills uninvocable, and warns too` },
    ],
    note:
      "A WARNING, not a hard error, and OQ-P5-5 is why: the pin doc-marks naming `Skill` in `tools`/`allowedTools` DEPRECATED in favour of the `skills` option itself (`sdk.d.ts:44`, `1438`), so WS-11 §2.2's MUST describes a deprecated path. Refusing to start would invent a failure the pinned branch does not have; silence would leave a caller with a skill list that quietly does nothing.",
  },
  {
    id: "WS11-04f",
    spec: "WS-11 §10",
    bullet: "skills: command/skill overlap resolution (P5-H: the SKILL wins)",
    status: "covered",
    citations: [
      { file: "./commands/resolver.test.ts", testName: `OVERLAP: a SKILL wins over a command file of the same name, and the source says which` },
      { file: "./commands/resolver.test.ts", testName: `every listed name resolves, and every resolvable name is listed -- the invariant, swept` },
      { file: "./commands/resolver.test.ts", testName: `an \`off\` skill blocks its ALIAS too` },
    ],
    note: "P5-H is DISCLOSED AND CAPTURE-PENDING: the pin's own resolution was not observable in T1's captures, and `task-5-brief.md` line 7 says the opposite of the dispatch. The substantive argument for the skill is that it is also the surface the MODEL sees, so `/review` and `Skill(\"review\")` returning different text would be a real split brain.",
  },
  {
    id: "WS11-04g",
    spec: "WS-11 §10",
    bullet: "skills: the invocation reaches a live session end to end (the executor, on every transport leg)",
    status: "new",
    citations: [
      { file: "./tools/impl/partial-wiring.test.ts", testName: `a fresh process importing ONLY the barrel finds a real Skill executor` },
      { file: "../../sdk/src/transport-equivalence.test.ts", testName: `P5 skill-invocation round: the tool RESULT is the skill body, on both legs` },
    ],
  },

  // --- bullet 5: plugins --------------------------------------------------------------------------
  {
    id: "WS11-05a",
    spec: "WS-11 §10",
    bullet: "plugins: `.winter` root qualification (`.winter:<skill>`) identical across both branches",
    status: "covered",
    citations: [
      { file: "./plugins/loader.test.ts", testName: `\`.winter\` as a plugin root qualifies its skills \`.winter:<skill>\` on BOTH branches` },
      { file: "./skills/store.test.ts", testName: `a project skill answers to BOTH its bare name and \`.winter:<name>\`, and lists under the bare one` },
      { file: "./skills/store.test.ts", testName: `the SAME \`.winter\` tree reached as a loaded PLUGIN qualifies identically -- one name, not two entries` },
      { file: "./commands/resolver.test.ts", testName: `\`/.winter:<name>\` resolves to the skill body, exactly as the bare name does` },
    ],
  },
  {
    id: "WS11-05b",
    spec: "WS-11 §10",
    bullet: "plugins: `system/init` exposure of RESOLVED plugin paths",
    status: "new",
    citations: [
      { file: "./plugins/loader.test.ts", testName: `\`pluginInitInfo\` is the \`system/init.plugins\` shape: name, resolved path, optional version` },
      { file: "./plugins/loader.test.ts", testName: `every emitted path is ABSOLUTE and resolved, even from a relative config path` },
      { file: "./production-wiring.test.ts", testName: `\`slash_commands\` and \`skills\` reflect the resolved surface, not a hardcoded empty array` },
    ],
    note:
      "The producer existed; T8 wires it onto the frame (rider 4). The cited wiring test asserts the sibling init fields on a real run rather than `plugins` specifically, because a plugin fixture would add a second temp tree to a test whose subject is the settings tier -- the field is populated by the same one-line producer as its siblings, from `pluginInitInfo`, and the `initPlugins` field is threaded and typed at `engine.ts`. DISCLOSED as the weaker half of this row.",
  },

  // --- bullet 6: memory ---------------------------------------------------------------------------
  {
    id: "WS11-06a",
    spec: "WS-11 §10",
    bullet: "memory: the 200-line / 25 KB cap, version-drift-tested",
    status: "covered",
    citations: [
      { file: "./context/memory.test.ts", testName: `the pinned numbers are 200 and 25 * 1024` },
      { file: "./context/memory.test.ts", testName: `EXACTLY 200 lines loads whole -- the boundary is not off by one` },
      { file: "./context/memory.test.ts", testName: `201 lines is cut to 200 and marked` },
      { file: "./context/memory.test.ts", testName: `25 KB + 1 byte is cut at 25 KB and marked` },
      { file: "./context/memory.test.ts", testName: `when BOTH caps would bite, the line cap is applied first` },
    ],
  },
  {
    id: "WS11-06b",
    spec: "WS-11 §10",
    bullet: "memory: git-common-root sharing across worktrees",
    status: "covered",
    citations: [
      { file: "./context/memory-key.test.ts", testName: `a linked worktree and its main checkout resolve to the SAME memory directory` },
      { file: "./context/memory-key.test.ts", testName: `a SUBDIRECTORY of the main checkout also shares it (the key is the repo root, not the cwd)` },
      { file: "./context/assembler.test.ts", testName: `both cwds name one memory directory in the assembled prompt` },
    ],
    note: "Driven against a REAL `git worktree add` fixture, not a hand-built `.git` -- which is what caught the macOS `/var` -> `/private/var` canonicalisation defect in the `WINTER.md` walk that a synthetic fixture would have shipped.",
  },
  {
    id: "WS11-06c",
    spec: "WS-11 §10",
    bullet: "memory: `_global`/`_assistant` are never injected into a Code session",
    status: "covered",
    citations: [{ file: "./context/memory-key.test.ts", testName: `the product buckets \`_global\`/\`_assistant\` are reserved and unreachable from a computed key` }],
    note: "Proved as a PROPERTY, not as one lucky path: the pinned sanitiser maps every non-alphanumeric to `-`, so no computed key can begin with `_`.",
  },

  // --- bullet 7: system prompt ---------------------------------------------------------------------
  {
    id: "WS11-07a",
    spec: "WS-11 §10",
    bullet: "system prompt: minimal default vs preset selection, and `append`",
    status: "covered",
    citations: [
      { file: "./context/assembler.test.ts", testName: `undefined renders the AUTHORED MINIMAL prompt, stamped with its own version` },
      { file: "./context/assembler.test.ts", testName: `the preset arm renders the authored winter_code preset, stamped` },
      { file: "./context/assembler.test.ts", testName: `\`append\` lands after the preset and never displaces any of it` },
      { file: "./context/assembler.test.ts", testName: `a string REPLACES the authored prompt entirely, and stamps no version` },
    ],
  },
  {
    id: "WS11-07b",
    spec: "WS-11 §10",
    bullet: "system prompt: `excludeDynamicSections` moves dynamic content to the FIRST user block",
    status: "covered",
    citations: [
      { file: "./context/assembler.test.ts", testName: `true MOVES the dynamic block out of \`system\` and makes it the FIRST user-context block` },
      { file: "./context/assembler.test.ts", testName: `false / absent keeps the dynamic block in \`system\`` },
      { file: "./context/assembler.test.ts", testName: `it is INERT for a string prompt` },
    ],
  },
  {
    id: "WS11-07c",
    spec: "WS-11 §10",
    bullet: "system prompt: `WINTER.md` arrives as CONTEXT, never as system-prompt concatenation",
    status: "covered",
    citations: [
      { file: "./context/assembler.test.ts", testName: `WINTER.md never reaches \`system\`, and the pinned order is dynamic (if moved) -> user -> project -> memory` },
      { file: "./context/winter-md.test.ts", testName: `the walk collects every WINTER.md from the repo root down to the cwd, OUTERMOST FIRST` },
      { file: "./context/winter-md.test.ts", testName: `a WINTER.md ABOVE the repo root is never read -- the walk stops at the toplevel` },
    ],
    note:
      "OQ-P5-1 is DECIDED and disclosed: the pin gates CLAUDE.md discovery on `'project'` being in `settingSources` (`sdk.d.ts:2050`) while R5-9 says `WINTER.md` is ALWAYS injected. Winter mirrors the PIN (P5-A source-gates project skills/commands/WINTER.md), so a `settingSources: []` session reads none -- see the source-gating rows in `winter-md.test.ts`.",
  },
  {
    id: "WS11-07d",
    spec: "WS-11 §10",
    bullet: "system prompt: byte-identical assembly when no output style is set",
    status: "covered",
    citations: [
      { file: "./context/assembler.test.ts", testName: `SNAPSHOT: with no style set the assembled prompt is byte-identical to the explicit \`default\`` },
      { file: "./context/assembler.test.ts", testName: `an unresolvable style name changes nothing either` },
      { file: "./context/assembler.test.ts", testName: `assembly is deterministic: the same input twice produces byte-identical output` },
    ],
  },
  {
    id: "WS11-07e",
    spec: "WS-11 §10",
    bullet: "system prompt: the assembler is the LIVE request's prompt on every transport leg (not merely a correct return value)",
    status: "new",
    citations: [
      { file: "./context/assembler.test.ts", testName: `ground truth is the LIVE request` },
      { file: "../../sdk/src/transport-equivalence.test.ts", testName: `P5 assembler round: Lane C's assembled prompt is on the LIVE request, identically on both legs` },
    ],
    note:
      "The Global Constraints' own ground-truth rule: an assembler that returns the right string and an engine that drops it look identical from the assembler's own tests. T8's wiring is what puts it on the wire, and the equivalence suite's `expectEchoedPrompt` is where the composed user message is asserted on every leg.",
  },
  {
    id: "WS11-07f",
    spec: "WS-11 §10",
    bullet: "system prompt: a project-tier output style may APPEND but not REPLACE (RULING P5-G), observably",
    status: "new",
    citations: [
      { file: "./context/assembler.test.ts", testName: `UNTRUSTED: the replacement is downgraded to an append` },
      { file: "./context/assembler.test.ts", testName: `TRUSTED: the same file replaces, and nothing is reported as downgraded` },
    ],
    note: "Rider 22. `output-styles.test.ts` already proved `resolveOutputStyle`'s own downgrade; what had never been proven is that it SURVIVES ASSEMBLY, and that a caller can observe it (`AssembledPrompt.replacementDowngraded`).",
  },
  {
    id: "WS11-07g",
    spec: "WS-11 §10",
    bullet: "system prompt: dynamic sections on the caller-supplied `string`/`string[]` arms (rider 23)",
    status: "covered",
    citations: [
      { file: "./context/assembler.test.ts", testName: `a string prompt STILL renders the dynamic sections (item (c): they are not the caller's to remove)` },
      { file: "./context/assembler.test.ts", testName: `with NO boundary the whole array is static, and the dynamic sections follow it` },
      { file: "./context/assembler.test.ts", testName: `an empty array is not an empty prompt -- the dynamic sections still render` },
    ],
    note:
      "DISCLOSED DIVERGENCE-SHAPED CHOICE, capture-pending. Item (c) settles only the FLAG (`excludeDynamicSections` is nested in the preset object and inert for a string prompt); it says nothing about whether the sections RENDER on those arms. Winter renders them, and the reasoning is that the flag's inertness is the pin's own statement that a caller cannot remove them -- if they did not render there, the flag would have nothing to be inert about. A capture showing otherwise changes one branch in `resolveRegion`.",
  },

  // --- bullet 8: settings --------------------------------------------------------------------------
  {
    id: "WS11-08a",
    spec: "WS-11 §10",
    bullet: "settings: `settingSources` gating",
    status: "covered",
    citations: [
      { file: "./settings/resolve.test.ts", testName: `settingSources: [] disables filesystem settings entirely` },
      { file: "./settings/resolve.test.ts", testName: `a rule in a file whose tier is NOT selected has no effect` },
      { file: "./production-wiring.test.ts", testName: `the same tree with \`settingSources: []\` advertises neither -- source gating reaches BOTH producers` },
    ],
  },
  {
    id: "WS11-08b",
    spec: "WS-11 §10",
    bullet: "settings: managed-policy precedence",
    status: "covered",
    citations: [
      { file: "./settings/resolve.test.ts", testName: `managed > flag > local > project > user for scalars` },
      { file: "./settings/resolve.test.ts", testName: `managedSettings and serverManagedSettings both report source 'managed' with a policyOrigin` },
    ],
  },
  {
    id: "WS11-08c",
    spec: "WS-11 §10",
    bullet: "settings: `resolveSettings` provenance correctness",
    status: "covered",
    citations: [
      { file: "./settings/resolve.test.ts", testName: `provenance is per TOP-LEVEL key and names the winning tier + its path` },
      { file: "./settings/resolve.test.ts", testName: `a nested object merges across tiers but provenance stays per TOP-LEVEL key` },
      { file: "./settings/resolve.test.ts", testName: `\`sources\` is ordered highest-precedence first and carries the RAW per-tier settings` },
      { file: "./settings/resolve.test.ts", testName: `returns exactly the three pinned fields, and no Winter-side extras` },
    ],
  },
  {
    id: "WS11-08d",
    spec: "WS-11 §10",
    bullet: "settings: the RESOLVED tier is what a live session runs under (provenance, observed on the wire)",
    status: "new",
    citations: [
      { file: "./production-wiring.test.ts", testName: `a USER-tier settings file's outputStyle reaches system/init.output_style` },
      { file: "./production-wiring.test.ts", testName: `an explicit \`config.outputStyle\` BEATS the settings file -- the chain is config > settings > default` },
      { file: "./production-wiring.test.ts", testName: `the PROJECT tier loses \`autoMemoryDirectory\` (OVERLAY_NEVER_KEYS) while the USER tier keeps it` },
      { file: "./production-wiring.test.ts", testName: `rider 24: \`assertEffectiveSettings\` THROWS when handed a raw per-source view` },
    ],
    note:
      "The brief's settings-provenance scenario. In-memory by design: which TIER won is observable on the wire only through `system/init` and the assembled prompt, both of which are leg-invariant by construction (one wiring function, both entrypoints); what is NOT leg-invariant is which file was read, and that needs a controlled `~/.winter` tree.",
  },

  // --- bullet 9: compaction -------------------------------------------------------------------------
  {
    id: "WS11-09a",
    spec: "WS-11 §10",
    bullet: "compaction: PreCompact / post-compaction hook firing",
    status: "covered",
    citations: [{ file: "./compaction/seam.contract.test.ts", testName: `PreCompact runs BEFORE compact() and PostCompact AFTER it` }],
    note:
      "The engine's own sequence (PreCompact -> compact() -> persist -> frame -> PostCompact -> onCompaction -> swap) is the spine's, proved against the spine's fake in the seam contract file. `GATING_HOOK_EVENTS` already contained `PreCompact`, so the 60s gating timeout applies with no change; no veto is invented (WS-08 OQ4: `PreCompact` has no hook-specific output type on the pin, so there is no shape a veto could be expressed in).",
  },
  {
    id: "WS11-09b",
    spec: "WS-11 §10",
    bullet: "compaction: `/compact`",
    status: "new",
    citations: [
      { file: "./compaction/controller.test.ts", testName: `customInstructions are FOLDED INTO the instruction on a manual run, never dropped` },
      { file: "../../sdk/src/transport-equivalence.test.ts", testName: `P5 compaction round (manual /compact): its own terminal result, on both legs` },
    ],
  },
  {
    id: "WS11-09c",
    spec: "WS-11 §10",
    bullet: "compaction: transcript persistence + resume ACROSS a compaction",
    status: "covered",
    citations: [
      { file: "./compaction/resume-across-compaction.test.ts", testName: `a LIVE compaction's retention and the RESUMED session's rebuilt history are the same conversation` },
      { file: "./compaction/resume-across-compaction.test.ts", testName: `the summary the model wrote is what resume replays -- not a paraphrase and not the raw messages` },
      { file: "./compaction/resume-across-compaction.test.ts", testName: `the emitted compact_boundary frame carries preserved_messages, and OMITS post_tokens (A-8)` },
    ],
  },
  {
    id: "WS11-09d",
    spec: "WS-11 §10",
    bullet: "compaction: deferred-tool rediscovery (`registry.onCompaction`)",
    status: "covered",
    citations: [
      { file: "./compaction/retention.test.ts", testName: `names every tool the retained messages still show being called, first-appearance order` },
      { file: "./compaction/retention.test.ts", testName: `a tool whose evidence was summarized away is NOT evidenced` },
    ],
    note:
      "`evidencedToolNames` reports EVERY referenced tool rather than a `descriptor.deferred`-filtered subset -- a disclosed reading. The filtered set is behaviourally identical at best (`onCompaction` INTERSECTS, never unions) and strictly worse at worst: a descriptor whose `deferred` is a `PermissionMode[]` reads as not-deferred outside those modes, so filtering here would silently unload a tool the model is visibly still using.",
  },
  {
    id: "WS11-09e",
    spec: "WS-11 §10",
    bullet: "compaction: the AUTO trigger on a real threshold crossing, end to end on every leg",
    status: "new",
    citations: [
      { file: "./compaction/controller.test.ts", testName: `fires at exactly \`compactionThreshold x limit()\` and not one token before` },
      { file: "../../sdk/src/transport-equivalence.test.ts", testName: `P5 compaction round (auto): a threshold crossing produces ONE compact_boundary on both legs` },
      { file: "./compaction/resume-across-compaction.test.ts", testName: `rider 17: a controller that returns the FULL INPUT is refused` },
    ],
  },

  // --- bullet 10: structured output ------------------------------------------------------------------
  {
    id: "WS11-10a",
    spec: "WS-11 §10",
    bullet: "structured output: the default-5 retry loop and the `MAX_STRUCTURED_OUTPUT_RETRIES` override",
    status: "covered",
    citations: [
      { file: "./structured/exhaustion.test.ts", testName: `the budget counts ATTEMPTS: the default is five validation failures, not six` },
      { file: "./structured/exhaustion.test.ts", testName: `every failed attempt hands the model AJV's own error text, not a bare rejection` },
      { file: "../../sdk/src/transport-equivalence.test.ts", testName: `P5 structured-output round (exhaustion): both pinned spellings, on both legs` },
    ],
  },
  {
    id: "WS11-10b",
    spec: "WS-11 §10",
    bullet: "structured output: `error_max_structured_output_retries` termination (BOTH pinned spellings, on two fields)",
    status: "covered",
    citations: [{ file: "./structured/exhaustion.test.ts", testName: `EXHAUSTION carries BOTH pinned spellings, on their own fields, and NO structured_output` }],
    note: "Item (d)'s two spellings live on DIFFERENT fields of the same message -- `subtype: error_max_structured_output_retries` and `terminal_reason: structured_output_retry_exhausted`. No type-checker catches confusing them, which is why both are asserted literally in two places.",
  },
  {
    id: "WS11-10c",
    spec: "WS-11 §10",
    bullet: "structured output: the host-generated `StructuredOutput` schema IS the caller's, byte-for-byte",
    status: "covered",
    citations: [
      { file: "./structured/validator.test.ts", testName: `the caller's schema lands on inputSchema BY IDENTITY -- not a copy, not a wrapper` },
      { file: "./structured/validator.test.ts", testName: `a schema whose own keys collide with descriptor fields still rides through untouched` },
      { file: "./structured/exhaustion.test.ts", testName: `the schema the ENGINE registered is the caller's own object, and the tool is advertised` },
    ],
    note: "Item (d)/capture (6): the pinned `StructuredOutput` tool has NO static schema, confirmed twice. The descriptor is built from a fresh object literal and NEVER a spread -- a caller schema is arbitrary JSON and may legally carry `description`/`type`/`source` keys, which a spread would let silently rewrite the tool's own identity.",
  },
  {
    id: "WS11-10d",
    spec: "WS-11 §10",
    bullet: "structured output: a valid call ENDS THE TURN with `structured_output`",
    status: "covered",
    citations: [
      { file: "./structured/exhaustion.test.ts", testName: `a VALID call ends the turn with structured_output and NO terminal_reason` },
      { file: "./structured/exhaustion.test.ts", testName: `an invalid attempt followed by a valid one succeeds -- the failure is a retry, not a terminal state` },
      { file: "../../sdk/src/transport-equivalence.test.ts", testName: `P5 structured-output round (success): the validated object ends the turn, on both legs` },
    ],
  },

  // --- bullet 11: checkpointing -----------------------------------------------------------------------
  {
    id: "WS11-11a",
    spec: "WS-11 §10",
    bullet: "checkpointing: tracked-tool-only rewind, with Bash and subagent changes untouched",
    status: "covered",
    citations: [
      { file: "./checkpoint/sink.test.ts", testName: `a mixed Write/Bash sequence rewinds the Write and leaves the Bash-created file alone` },
      { file: "./checkpoint/sink.test.ts", testName: `a SUBAGENT's edits are untouched -- they are its own session's checkpoints, not the parent's` },
      { file: "../../sdk/src/transport-equivalence.test.ts", testName: `P5 checkpoint-rewind round: a real Write is undone, a Bash-created file is not, on both legs` },
    ],
    note:
      "The honest consequence, fixtured rather than glossed: a rewind restores PATHS, not authorship -- a Bash EDIT to a TRACKED file is undone as collateral, while a Bash-CREATED file is untouched. That is the mechanism class WS-11 §9 pins.",
  },
  {
    id: "WS11-11b",
    spec: "WS-11 §10",
    bullet: "checkpointing: session scoping",
    status: "covered",
    citations: [
      { file: "./checkpoint/sink.test.ts", testName: `two sessions under one home never see each other's checkpoints` },
      { file: "./checkpoint/engine-rewind.test.ts", testName: `an id from a DIFFERENT session cannot rewind this one` },
    ],
  },
  {
    id: "WS11-11c",
    spec: "WS-11 §10",
    bullet: "checkpointing: the typed rejection of `enableFileCheckpointing` + an external `SessionStore`",
    status: "new",
    citations: [
      { file: "../../sdk/src/query.test.ts", testName: `enableFileCheckpointing + sessionStore: a PLAIN Error, verbatim` },
      { file: "../../sdk/src/query.test.ts", testName: `VALIDATION ORDER is observable, and matches: persistSession is checked FIRST and wins` },
    ],
    note:
      "Rider 6 / P5-E. Capture (2) settles WS-11 OQ3: the rejection is a PLAIN `Error` thrown synchronously at `query()` construction, and the class matters -- a typed `WinterUnsupportedCombinationError` would be STRICTER than the pin, i.e. a divergence to disclose rather than parity. The brand rename (`CLAUDE_CONFIG_DIR` -> `WINTER_HOME`) is the ONE permitted substitution, per P5-E.",
  },
  {
    id: "WS11-11d",
    spec: "WS-11 §10",
    bullet: "checkpointing: the backup store cannot be turned into an arbitrary write or delete (rider 25)",
    status: "new",
    citations: [
      { file: "./permissions/baseline-backups-deny.test.ts", testName: `Write to the checkpoint index is DENIED under bypass (the tampered-index case)` },
      { file: "./sandbox/deny.darwin.test.ts", testName: `a sandboxed write under <home>/.winter/backups is denied while a sibling under the same .winter writes fine` },
      { file: "./checkpoint/sink.test.ts", testName: `a hostile record naming a path OUTSIDE the session's roots cannot DELETE it` },
    ],
    note:
      "Not a WS-11 §10 bullet -- a SECURITY row this task adds, because the three fences it names are the reason the rest of this bullet group is safe to ship. `index.jsonl` names the paths a rewind writes to and `backups/` holds the bytes it writes; before T8 nothing protected either half, and `rewindToCheckpoint` acted on every path the index carried.",
  },

  // --- riders 1 and 2: the reconciliations WS-11 §10 does not itself name ---------------------------
  {
    id: "WS11-R1",
    spec: "T8 rider 1 / OQ-P5-12",
    bullet: "the pinned `system/init` advertises `Task` where its own API request says `Agent`; the default sets differ by 15 names",
    status: "new",
    citations: [{ file: "./conformance-ws11.test.ts", testName: `rider 1: the init/request tool-name alias and the 15-name difference are RECONCILED, name by name` }],
    note:
      "Capture (4). Winter's own default set is now 31 (29 before T8, plus `Skill` and `Workflow`). The reconciliation is the row below, which enumerates every name on both sides and classifies it -- because OQ-P5-12's own warning is that any conformance assertion comparing an init tool list against a request tool list disagrees with the pin unless it models the alias.",
  },
  {
    id: "WS11-R2a",
    spec: "T8 rider 2 / OQ-P5-10",
    bullet: "CAPTURE-PENDING: whether project-tier `ask` rules are honoured",
    status: "deferred",
    owningPhase: "WS-17 capture (a differential run against the pinned runtime)",
    note:
      "Capture (1) cell M is NON-DISCRIMINATING -- it cannot tell an honoured project `ask` from a dropped one. Winter's shipped reading honours it (`PROJECT_PERMISSIVE_KEYS` deliberately excludes `deny`/`ask`, because both only ever tighten), which is the strictly safer of the two and is what P5-A states. One capture settles it; nothing else can.",
  },
  {
    id: "WS11-R2b",
    spec: "T8 rider 2",
    bullet: "CAPTURE-PENDING: whether a settings-file `defaultMode` reaches SDK-mode behaviour",
    status: "deferred",
    owningPhase: "WS-17 capture",
    note:
      "Winter resolves `permissions.defaultMode` through `resolveSettings` and applies the pinned escalating-mode filter (`filterEscalatingDefaultMode`), which capture (1) DOES pin. What is uncaptured is whether the surviving value then governs an SDK-mode session's own starting mode, or only the interactive one. Winter's engine seeds from `config.permissionMode` alone today; the settings value reaches `effective` and no further. Disclosed rather than guessed.",
  },
  {
    id: "WS11-R2c",
    spec: "T8 rider 2 / OQ-P5-8",
    bullet: "CAPTURE-PENDING: the `notification_type` vocabulary",
    status: "deferred",
    owningPhase: "P2 carry (WS-08) -- the values will be Winter-defined until a capture pins any",
    note:
      "`NotificationHookInput.notification_type` is an OPEN `string` with no declared values (`sdk.d.ts:1333`), and no R5-13 emission point fires in a single-shot canned run, so capture could not observe one either. OQ-P5-8's own instruction is not to reuse `SDKNotificationMessage.priority`'s closed four-member union for it.",
  },
  {
    id: "WS11-R2d",
    spec: "T8 rider 2 / OQ-P5-11",
    bullet: "CAPTURE-PENDING: the `<path-hash>` algorithm inside `backups/`",
    status: "deferred",
    owningPhase: "WS-17 capture (R5-11's own wording marks it pending)",
    note:
      "Capture (2) observed the `backups/` DIRECTORY (settling OQ-P5-11's location question) but never drove a rewind, so the per-file naming inside it is unobserved. Winter ships R5-11's own named fallback -- the first 16 hex of sha256 of the ABSOLUTE path -- behind one function (`checkpointPathHash`), so a capture changes one line.",
  },
  {
    id: "WS11-R2e",
    spec: "T8 rider 2 / OQ-P5-13",
    bullet: "DISCLOSED: four `system/init` fields are on the pinned wire but absent from `SDKSystemMessage`",
    status: "deferred",
    owningPhase: "T3 + Lane C (the declaration is the contract Winter builds to; `memory_paths` is the one with a P5 consumer)",
    note:
      "`analytics_disabled`, `product_feedback_disabled`, `memory_paths`, `messaging_socket_path`. A declaration-driven Winter init frame omits all four SILENTLY. `memory_paths` is directly load-bearing for §3/§6.3 -- Winter does surface the memory directory, but in the DYNAMIC SECTIONS and the auto-memory user-context block rather than on a wire field, which is a different contract for a host that reads init.",
  },
  {
    id: "WS11-R2f",
    spec: "T8 rider 2 / OQ-P5-4",
    bullet: "DISCLOSED: `AgentDefinition.memory` selects a per-agent-type tree, not auto-memory",
    status: "deferred",
    owningPhase: "Lane C + WS-10 (WS-11 §3 conflates the two)",
    note:
      "The pinned field is `'user' | 'project' | 'local'` scoping `agent-memory/<agentType>/` trees -- a THIRD location, with a `-local` directory-name suffix. WS-11 §3's own sentence ('Children participate via `AgentDefinition.memory`') sits in a section about auto-memory at `projects/<key>/memory/`. Winter ships neither the three trees nor the conflation; the field is accepted and inert.",
  },
];

// ================================================================================================
// The one new fixture this file owns, plus the alias reconciliation rider 1 asks for.
// ================================================================================================

describe("WS-11 §10: the rows this file closes directly", () => {
  test("verify:workflow is a CI STEP, not merely a script that exists", () => {
    // A gate nothing runs is not a gate. `package.json` gained the script line at Lane W's merge;
    // rider 8/21 is about the CI job actually invoking it, which no other test could observe.
    const pkg = readFileSync(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8");
    expect(JSON.parse(pkg).scripts["verify:workflow"]).toBe("bun run scripts/verify-workflow.ts");
    const ci = readFileSync(fileURLToPath(new URL("../../../.github/workflows/ci.yml", import.meta.url)), "utf8");
    expect(ci).toContain("bun run verify:workflow");
    // And it runs in the SAME job as the other compiled-binary gate, not a separate one whose
    // failure a reader might miss.
    const buildJob = ci.slice(ci.indexOf("  build:"), ci.indexOf("  official-fixture-compile:"));
    expect(buildJob).toContain("bun run verify:workflow");
    expect(buildJob).toContain("bun run verify:compiled");
  });

  test("rider 1: the init/request tool-name alias and the 15-name difference are RECONCILED, name by name", () => {
    // Capture (4)'s own list, transcribed. `Task` is the name the pinned `system/init` carries; the
    // pin's own API REQUEST says `Agent` for the same tool -- so the pinned runtime advertises one
    // name to the host and a different one to the model, and OQ-P5-12 warns that any conformance
    // assertion comparing the two lists disagrees unless it models the alias.
    const PINNED_INIT_24 = [
      "Task", "Bash", "CronCreate", "CronDelete", "CronList", "DesignSync", "Edit", "EnterWorktree",
      "ExitWorktree", "ListAgents", "Monitor", "NotebookEdit", "PushNotification", "Read", "ReportFindings",
      "ScheduleWakeup", "SendMessage", "Skill", "TaskOutput", "TaskStop", "WebFetch", "WebSearch",
      "Workflow", "Write",
    ];
    expect(PINNED_INIT_24.length).toBe(24); // capture (4) confirms the brief's figure exactly

    // THE ALIAS, modelled explicitly rather than left to a reader: `Task`(init) IS `Agent`(request).
    const ALIAS_INIT_TO_REQUEST: Record<string, string> = { Task: "Agent" };
    const pinnedUnderRequestNames = PINNED_INIT_24.map((n) => ALIAS_INIT_TO_REQUEST[n] ?? n);
    expect(pinnedUnderRequestNames).toContain("Agent");
    expect(pinnedUnderRequestNames).not.toContain("Task");

    // Winter's own default advertised set, as the committed golden holds it. Read from the golden
    // rather than re-derived, so this row can never disagree with what a session actually emits.
    const golden = JSON.parse(readFileSync(fileURLToPath(new URL("../../conformance/goldens/plain-query.trace.json", import.meta.url)), "utf8")) as Array<{ payload: { tools?: string[] } }>;
    const winter = golden[0]!.payload.tools!;

    // EVERY NAME ON BOTH SIDES IS CLASSIFIED. A `difference` this row merely counted would go stale
    // the first time a tool was added; enumerating both directions makes a change fail HERE.
    const onlyInPin = pinnedUnderRequestNames.filter((n) => !winter.includes(n)).sort();
    const onlyInWinter = winter.filter((n) => !pinnedUnderRequestNames.includes(n)).sort();

    // IN THE PIN, ABSENT FROM WINTER -- three, each with a stated reason:
    //   DesignSync  -- a product surface WS-06 does not carry (correctly-absent by catalog).
    //   WebFetch/WebSearch -- WS-06 rows with no executor at this phase; the task brief's own
    //   "no P5 tool stays executorless except ProposeSkills/ProposeGoal, LSP, WebFetch/WebSearch"
    //   names them as the sanctioned exceptions.
    expect(onlyInPin).toEqual(["DesignSync", "WebFetch", "WebSearch"]);

    // IN WINTER, ABSENT FROM THE PIN -- ten, every one a WS-06 catalog row this branch implements.
    // `Skill` and `Workflow` are NO LONGER in this list: T8's own wiring put them in Winter's
    // default set, which is exactly the parity movement this phase was for.
    expect(onlyInWinter).toEqual([
      "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "Glob", "Grep",
      "ReadNotifications", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate",
    ]);
    // Thirteen names differ, not fifteen: capture (4) counted `Skill` and `Workflow` among the
    // pin-only five, and both are Winter's now.
    expect(onlyInPin.length + onlyInWinter.length).toBe(13);
    expect(winter).toContain("Skill");
    expect(winter).toContain("Workflow");
    // And the alias is REAL on Winter's side too: it advertises `Agent` on init, where the pin says
    // `Task` -- a DISCLOSED rename (WS-06's catalog name), not an accidental omission.
    expect(winter).toContain("Agent");
    expect(winter).not.toContain("Task");
  });
});

// ================================================================================================
// Machine-verification of the matrix itself.
// ================================================================================================

describe("WS-11 §10 fixture matrix", () => {
  test("every row carries a verdict, and every non-deferred row carries at least one citation", () => {
    for (const row of WS11_10) {
      expect(["covered", "new", "deferred"]).toContain(row.status);
      if (row.status === "deferred") {
        expect(row.owningPhase, `${row.id} (${row.bullet}): a deferred row must name its owning phase`).toBeTruthy();
        expect(row.note, `${row.id}: a deferred row must state the EVIDENCE for the absence, never a bare deferral`).toBeTruthy();
      } else {
        expect(row.citations?.length ?? 0, `${row.id} (${row.bullet}): a ${row.status} row must carry at least one citation`).toBeGreaterThan(0);
      }
    }
  });

  test("every citation's file exists and genuinely contains the cited substring -- a renamed or deleted cited test fails HERE, not silently in a stale table", () => {
    const fileCache = new Map<string, string>();
    const readCited = (relPath: string): string => {
      let content = fileCache.get(relPath);
      if (content === undefined) {
        content = readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), "utf8");
        fileCache.set(relPath, content);
      }
      return content;
    };
    const countOccurrences = (haystack: string, needle: string): number => {
      let count = 0;
      let from = 0;
      for (;;) {
        const at = haystack.indexOf(needle, from);
        if (at === -1) return count;
        count++;
        from = at + 1;
      }
    };
    for (const row of WS11_10) {
      for (const c of row.citations ?? []) {
        const content = readCited(c.file);
        // SELF-CITATION GUARD, carried verbatim from permissions/conformance.test.ts: a row citing
        // THIS file has its own `testName` string literal sitting right here in the table, which
        // would trivially satisfy a plain `.includes()` even if the real `test(...)` below were
        // renamed or deleted -- the check would then be verifying the table against itself.
        // Requiring TWO occurrences when self-citing closes that; every other file keeps one.
        const isSelfCitation = c.file === "./conformance-ws11.test.ts";
        const required = isSelfCitation ? 2 : 1;
        const occurrences = countOccurrences(content, c.testName);
        expect(
          occurrences >= required,
          `${row.id}: citation not found -- ${c.file} does not contain ${required} occurrence(s) of a test/describe title matching "${c.testName}" (found ${occurrences})`,
        ).toBe(true);
      }
    }
  });

  test("a citation may never point at a SOURCE file's description string -- only at a test title", () => {
    // The second half of the self-citation guard, generalised. A row could otherwise "cite" a
    // descriptor's `description` field or a comment in an implementation file and pass the
    // substring check while proving nothing ran. Every cited path must be a test file.
    for (const row of WS11_10) {
      for (const c of row.citations ?? []) {
        expect(c.file.endsWith(".test.ts"), `${row.id}: ${c.file} is not a test file`).toBe(true);
      }
    }
  });

  test("row ids are unique", () => {
    const ids = WS11_10.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("summary counts (informational -- printed for the task report)", () => {
    const covered = WS11_10.filter((r) => r.status === "covered").length;
    const newRows = WS11_10.filter((r) => r.status === "new").length;
    const deferred = WS11_10.filter((r) => r.status === "deferred").length;
    expect(covered + newRows + deferred).toBe(WS11_10.length);
    // Printed so the report can quote it rather than recount it by hand.
    console.log(`WS-11 §10 matrix: ${WS11_10.length} rows -- ${covered} covered, ${newRows} new, ${deferred} deferred`);
  });
});
