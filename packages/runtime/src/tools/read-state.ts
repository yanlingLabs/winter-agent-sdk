// WS-06 §3.1's read-before-edit ladder (Lane B, Task 5) needs to know, PER SESSION, which files
// have already been read this session and how completely -- "older model families require a
// complete in-session read... a changed-since-read file is editable when the exact current match is
// unambiguous." SessionReadState is the seam the task-1 brief pins (verbatim); this module supplies
// the one production implementation the engine constructs once per run (registry.ts's
// buildRegistryToolExecutor takes it as a dependency, never constructs its own).
//
// Ruling P3-D (spine amendment; Lane B Task 5 fix-round concern 3): Lane A (Read/Glob/Grep) and Lane
// B (Edit/Write/NotebookEdit) are two INDEPENDENT executor lanes that both populate/consume this one
// seam, and nothing forces them to agree on a path CONVENTION -- Lane B keys by lexical
// `path.resolve`, Lane A may realpath. On macOS a lexical resolve and a realpath of the identical
// logical file disagree the moment any ancestor is a symlink (e.g. `/tmp` -> `/private/tmp`), so a
// lexically-keyed recordRead("/tmp/x") would silently never satisfy a realpath'd
// lookup("/private/tmp/x"), or vice versa -- a correctness gap the read-before-edit ladder would
// fail closed on (treating an actually-read file as never-read) without ever raising an error.
// Rather than mandate a convention on every current and future caller (unenforceable -- nothing
// stops a third lane from getting it wrong too), this seam now canonicalizes every key ITSELF, so
// caller convention is irrelevant: `canonicalKey` resolves a relative path against the `cwd` fixed
// at construction time (see SessionReadStateOptions below -- a per-call cwd would let two calls for
// what the caller believes is "the same relative path" silently key differently within one session),
// then reuses permissions/paths.ts's own `resolveRealTarget` -- realpath-with-graceful-fallthrough
// for a not-yet-existing suffix (e.g. a file about to be Written, which cannot exist yet) -- rather
// than forking that algorithm a second time. Read/Edit/Write's own executors may still pass whatever
// spelling they have on hand -- lexical, realpath'd, relative, it no longer matters, which is the
// point. (`tools/paths-seam.ts` is a different module entirely -- a lexical-only, no-realpath
// resolve-and-dedupe helper for Bash's approval-matching path extraction; it solves a different
// problem and is not reused here.)
import { isAbsolute, join, normalize } from "node:path";
import { resolveRealTarget } from "../permissions/paths.ts";

export interface ReadRecord {
  complete: boolean;
  mtimeMs: number;
}

export interface SessionReadState {
  recordRead(p: string, o: ReadRecord): void;
  lookup(p: string): ReadRecord | undefined;
}

export interface SessionReadStateOptions {
  // Base a relative path passed to recordRead/lookup resolves against. Construction-time only
  // (never per-call, see the ruling note above) so a session's keying stays internally consistent.
  // Defaults to process.cwd() -- every current caller (engine.ts) passes only absolute paths, so
  // this default is never exercised in production today; it exists so relative-path callers get a
  // deterministic, documented resolution instead of an implicit dependency on the daemon's own
  // process cwd at the call site.
  cwd?: string;
}

// A fresh, empty, in-memory read history -- engine.ts constructs exactly one of these per run
// (session-scoped lifetime, mirroring how PolicyStateStore/hookRegistry are also built once per
// run) and threads it into every ToolExecutionContext that run ever builds.
export function createSessionReadState(opts: SessionReadStateOptions = {}): SessionReadState {
  const cwd = opts.cwd ?? process.cwd();
  const reads = new Map<string, ReadRecord>();

  function canonicalKey(p: string): string {
    const abs = isAbsolute(p) ? p : join(cwd, p);
    return resolveRealTarget(normalize(abs));
  }

  return {
    recordRead(p, o) {
      reads.set(canonicalKey(p), { complete: o.complete, mtimeMs: o.mtimeMs });
    },
    lookup(p) {
      return reads.get(canonicalKey(p));
    },
  };
}
