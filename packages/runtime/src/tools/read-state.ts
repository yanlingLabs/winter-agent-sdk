// WS-06 §3.1's read-before-edit ladder (Lane B, Task 5) needs to know, PER SESSION, which files
// have already been read this session and how completely -- "older model families require a
// complete in-session read... a changed-since-read file is editable when the exact current match is
// unambiguous." SessionReadState is the seam the task-1 brief pins (verbatim); this module supplies
// the one production implementation the engine constructs once per run (registry.ts's
// buildRegistryToolExecutor takes it as a dependency, never constructs its own).
//
// Keying is by whatever path string a tool's own executor passes -- this module performs NO
// resolution/normalization of its own (Read/Edit/Write's own executors are expected to key
// consistently, e.g. always the absolute path they actually opened); paths-seam.ts is where shared
// resolution helpers live, kept deliberately separate from this module's own record/lookup contract.

export interface ReadRecord {
  complete: boolean;
  mtimeMs: number;
}

export interface SessionReadState {
  recordRead(p: string, o: ReadRecord): void;
  lookup(p: string): ReadRecord | undefined;
}

// A fresh, empty, in-memory read history -- engine.ts constructs exactly one of these per run
// (session-scoped lifetime, mirroring how PolicyStateStore/hookRegistry are also built once per
// run) and threads it into every ToolExecutionContext that run ever builds.
export function createSessionReadState(): SessionReadState {
  const reads = new Map<string, ReadRecord>();
  return {
    recordRead(p, o) {
      reads.set(p, { complete: o.complete, mtimeMs: o.mtimeMs });
    },
    lookup(p) {
      return reads.get(p);
    },
  };
}
