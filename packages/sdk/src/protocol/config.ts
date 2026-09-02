// The wire-adjacent config contract the wrapper serializes as `--config-json` argv (WS-04 §7/§8)
// and the runtime (and, later, the compiled `winter` binary, Task 4) parses back. Lives in the sdk
// per Ruling P1-A: the plan's Task 3 interface block placed this runtime-side, but the sdk builds
// and serializes it while never being allowed to import the runtime (WS-02 §3) — so the contract
// itself has to live on the sdk side of that boundary, with the runtime importing it from here.
//
// Task 2 (this file's origin) only populates/consumes sessionId/cwd/model; the remaining fields
// are the full shape Task 3 (turn engine) and Task 9 (resume/continue/fork) will read — declared
// now so every producer/consumer across tasks compiles against one definition from the start.
//
// Task 5 (WS-07 §3.3 / phase ruling 1): allowedTools/disallowedTools/permissions/settingSources
// mirror Options' own fields (options.ts) exactly — same optional raw-string-grammar shapes, same
// serialize-only posture. The runtime engine (a later task) is the actual consumer.
import type { RuleSource } from "../permissions/types.ts";

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
  allowedTools?: string[];
  disallowedTools?: string[];
  // Task 6 (WS-07 §6.4): disableBypassPermissionsMode nests inside `permissions`, mirroring
  // Options' own field exactly (see options.ts's comment for the naming rationale) — a plain
  // boolean at P2; managed source-tagging arrives at P5.
  permissions?: { allow?: string[]; ask?: string[]; deny?: string[]; disableBypassPermissionsMode?: boolean };
  settingSources?: RuleSource[];
  // Task 6 (WS-07 §6.4, Ruling 8): the wire's own permissionMode field ABOVE stays an open string —
  // only this new field is added here. Selecting/switching into "bypassPermissions" requires this to
  // be `true`; the runtime engine gates both the initial config value and every later
  // set_permission_mode control request against it (packages/runtime/src/permissions/
  // policy-state.ts).
  allowDangerouslySkipPermissions?: boolean;
}
