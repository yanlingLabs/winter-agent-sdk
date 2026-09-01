// The wire-adjacent config contract the wrapper serializes as `--config-json` argv (WS-04 §7/§8)
// and the runtime (and, later, the compiled `winter` binary, Task 4) parses back. Lives in the sdk
// per Ruling P1-A: the plan's Task 3 interface block placed this runtime-side, but the sdk builds
// and serializes it while never being allowed to import the runtime (WS-02 §3) — so the contract
// itself has to live on the sdk side of that boundary, with the runtime importing it from here.
//
// Task 2 (this file's origin) only populates/consumes sessionId/cwd/model; the remaining fields
// are the full shape Task 3 (turn engine) and Task 9 (resume/continue/fork) will read — declared
// now so every producer/consumer across tasks compiles against one definition from the start.
export interface RuntimeConfig {
  sessionId: string;
  cwd: string;
  model: string;
  permissionMode?: string;
  maxTurns?: number;
  resume?: string;
  continue?: boolean;
  forkSession?: boolean;
  resumeSessionAt?: string;
  resumeDropsTurn?: boolean;
  persistSession?: boolean;
  winterHome?: string;
}
