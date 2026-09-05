// Phase 5 Task 3 (spine): the WORKFLOW WORKER ENTRY POINT -- RULING R5-15.
//
// This file exists NOW, with a stub body, for one reason: `main.ts` is on Lane W's no-touch list
// (R5-12) but the worker is spawned as `<self-binary> __workflow-worker`, so the argv dispatch has to
// live in main.ts and has to call something. R5-15 fixes the export's NAME and SIGNATURE here so the
// dispatch and Lane W's eventual implementation cannot disagree; the contract test pins the name.
//
// LANE W REPLACES THE BODY, NOT THE SIGNATURE. The signature is the one thing that must not move:
//
//   - `argv: string[]` is the FULL argv, not a sliced tail. main.ts finds `__workflow-worker` by NAME
//     (never by position) for the same reason its own `--config-json` parsing does: `bun src/main.ts
//     __workflow-worker ...` and the compiled `winter __workflow-worker ...` differ by one leading
//     slot, and index-based parsing silently breaks between the dev and compiled legs.
//   - `io` is INJECTED rather than read from `process`: the NDJSON bridge is the only thing on this
//     process's stdout, and a test that drove the worker through the real `process.stdout` could not
//     assert on what it wrote. It also keeps the worker harness (Lane W's own
//     `worker-harness.ts`) able to run the entry in-process.
//   - the return is an EXIT CODE, not `void`: main.ts exits with it. A worker that threw instead
//     would lose the distinction between "the workflow failed" and "the worker itself broke".
//
// COMPILED-BINARY CONSTRAINTS apply here exactly as they do in main.ts (this module is reachable from
// it, so it is bundled into the single-file executable): no dynamic `import()` of a computed path, no
// `import.meta.dir`-relative resource loads, no `require.resolve` at runtime.

/**
 * The argv marker that selects the worker role. ONE constant, so the dispatch, Lane W's spawner and
 * `verify:workflow` cannot disagree by a character.
 *
 * It lives HERE and not in `main.ts` deliberately (fix round 1, M5): `main.ts` is a top-level SCRIPT
 * -- importing it to read a constant would parse argv, resolve a session and start an engine as a
 * side effect of the import. A spawner needs the marker, and this module is the one place it can be
 * imported from safely: everything below is a declaration, so importing this file does nothing.
 */
export const WORKFLOW_WORKER_ARGV_FLAG = "__workflow-worker";

/**
 * Exit code returned by the stub. Distinct from a plain `1` so a `verify:workflow` run against a
 * spine-only build reports "the dispatch works, the worker is not implemented" rather than an
 * indistinguishable generic failure.
 */
export const WORKFLOW_WORKER_NOT_IMPLEMENTED_EXIT_CODE = 78;

export async function workflowWorkerMain(
  argv: string[],
  io: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream },
): Promise<number> {
  // Diagnostics go to STDERR only -- stdout is reserved for the NDJSON bridge exclusively, exactly as
  // main.ts reserves it for the frame stream (WS-04 §2/§6). Writing this notice to stdout would
  // corrupt the very channel Lane W is about to build.
  io.stderr.write(`winter: __workflow-worker is not implemented yet (Phase 5 Lane W); argv=${JSON.stringify(argv)}\n`);
  return WORKFLOW_WORKER_NOT_IMPLEMENTED_EXIT_CODE;
}
