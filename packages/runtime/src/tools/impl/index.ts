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
import "./agent.ts";
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

// --- Phase 4 Task 8: the four P4 lanes' own executors --------------------------------------------
//
// Every file below shipped correct and independently tested inside its own lane, and every one of
// those lane reports flagged the identical thing: "inert in any live session until the barrel lands"
// (Lane A's own OWED item, Lane B's "T8 owes / Impl barrel wiring", Lane D's tool executors). The
// barrel is the one file each lane was forbidden to touch, so this is where their `replaceExecutor`
// calls actually start running in production.
//
// Lane A (WS-09 §1.4) -- the four MCP bridge tools. Each installs an INERT default at module load
// (`resolveLifecycle: () => undefined`, mirroring advisor.ts's own pattern), so importing them is
// safe in a session with no MCP lifecycle at all: they answer a typed "no MCP lifecycle" tool error
// rather than throwing. engine.ts's own live wiring is what makes them do real work.
import "./list-mcp-resources-tool.ts";
import "./read-mcp-resource-tool.ts";
import "./read-mcp-resource-dir-tool.ts";
import "./refresh-mcp-tools.ts";
// Lane B (WS-09 §8) -- ToolSearch + WaitForMcpServers. Both read a session-KEYED side registry
// (toolsearch/search.ts's registerToolSearchSessionRuntime, which engine.ts now populates per run);
// with no registration they answer a typed "no session runtime registered" error, never a crash.
import "./tool-search.ts";
import "./wait-for-mcp-servers.ts";
// Lane D (WS-10 §10) -- the three messaging tools. They read a module singleton
// (messaging/router.ts's registerMessagingRuntime, engine.ts's own per-run registration below);
// absent, each answers a typed "no messaging runtime" error.
import "./send-message.ts";
import "./list-agents.ts";
import "./read-notifications.ts";

// --- Phase 5 Task 8: the two P5 lanes' own executors ---------------------------------------------
//
// Lane S (WS-11 §2.3) -- the Skill tool. Reads `skills/runtime.ts`'s session-keyed side registry
// (T8's production wiring populates it per run, in production-wiring.ts); with no registration it
// answers a typed "no skills runtime" tool error, never a crash.
//
// Lane W (WS-11 §1) -- the Workflow tool. Reads `workflows/host-registry.ts`'s module singleton
// (registered per run by the same wiring); absent, it answers a typed "no workflow runtime is
// configured for this session".
//
// EACH LANE'S REPORT NAMED THIS LINE AS ITS FIRST NEEDS_CONTEXT ITEM, and Lane W's named the trap:
// the tool is inert in THREE independent ways -- no barrel import (the descriptor's stub answers
// "registered but not yet executable"), no session registration (a typed "no runtime"), no
// capability token (never advertised at all) -- and each fails differently and silently, so a wiring
// that lands two of three looks like a working feature until someone calls it. All three land
// together: this import, `registerWorkflowSession`/`registerSkillSessionRuntime` in
// production-wiring.ts, and the `winter.skills`/`winter.workflows` entries in
// registry.ts's RUNTIME_DERIVED_CAPABILITIES (which derive FROM this import, so leg 3 cannot land
// without leg 1). `tools/impl/partial-wiring.test.ts` pins each leg's own failure text.
import "./skill.ts";
import "./workflow.ts";

// Named export mirroring `descriptors/index.ts`'s own `DESCRIPTORS_REGISTERED` precedent -- lets a
// consumer force this module to evaluate at an explicit point, and lets a future test assert "the
// impl barrel imported without throwing" as a real value.
export const EXECUTORS_WIRED = true;
