// Task 8 (P3 close-out): the production-wiring barrel every lane's own report flagged as missing --
// "no `tools/impl/index.ts` aggregator exists yet" (Lane B/C/D reports, verbatim) / "the standing T8
// rider" (Lane A/C adjudications). Each `descriptors/*.ts` file registers a STUB (T1); each SIBLING
// `tools/impl/*.ts` file calls `replaceExecutor` at module load to install the REAL executor over
// that stub -- but until THIS module is actually imported from the production path, none of those
// `replaceExecutor` calls ever run in a live session: `descriptors/index.ts` (engine.ts's own
// side-effect import) only reaches the stub registrations, never any lane's `impl/*.ts` file.
//
// Mirrors `descriptors/index.ts`'s own shape exactly (a side-effect-only barrel + one named boolean
// export so a consumer can force evaluation / assert "this imported without throwing" as a real
// value): imports every REAL tool executor file so its own top-level `replaceExecutor(...)` call
// runs. Two sibling files under this same directory are deliberately NOT imported here by name --
// `background-task-runtime.ts` (Bash/Monitor/TaskOutput/TaskStop's shared in-memory task registry)
// and `read-ladder.ts` (Edit/Write/NotebookEdit's shared read-before-edit ladder) are not tools
// themselves and register nothing; each real tool file that needs them already imports them
// directly, so they load transitively regardless.
//
// Every file below already imports its OWN `../descriptors/<name>.ts` for side effects before
// calling `replaceExecutor` (each lane's own "self-sufficiency" convention, verified against every
// file in this directory before writing this barrel) -- so the import order here does not matter,
// and this barrel does not need to import `descriptors/index.ts` itself for correctness. engine.ts
// and testing.ts import both barrels anyway (descriptors first, by existing convention), so the
// registration order in practice is: every stub, then every real executor replacing its own stub.
import "./advisor.ts";
import "./ask-user-question.ts";
import "./bash.ts";
import "./cron.ts";
import "./edit.ts";
import "./enter-plan-mode.ts";
import "./enter-worktree.ts";
import "./exit-plan-mode.ts";
import "./exit-worktree.ts";
import "./glob.ts";
import "./grep.ts";
import "./monitor.ts";
import "./notebook-edit.ts";
import "./push-notification.ts";
import "./read.ts";
import "./report-findings.ts";
import "./schedule-wakeup.ts";
import "./task-graph.ts";
import "./task-output.ts";
import "./task-stop.ts";
import "./todo-write.ts";
import "./write.ts";

// Named export mirroring `descriptors/index.ts`'s own `DESCRIPTORS_REGISTERED` precedent -- lets a
// consumer force this module to evaluate at an explicit point, and lets a future test assert "the
// impl barrel imported without throwing" as a real value.
export const EXECUTORS_WIRED = true;
