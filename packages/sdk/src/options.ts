import type { SpawnClaudeCodeProcess } from "./transport.ts";

export interface Options {
  model?: string;
  permissionMode?: string;          // full union arrives with WS-07; P0 accepts any string
  maxTurns?: number;
  cwd?: string;
  env?: Record<string, string>;     // REPLACES the child env (WS-03 §5); flows into SpawnRuntimeOptions.env
  pathToClaudeCodeExecutable?: string;   // WS-04 §8 resolution seam: explicit path wins over the platform package
  spawnClaudeCodeProcess?: SpawnClaudeCodeProcess; // WS-04 §8 seam; default is a real child (transport.ts's defaultSpawn)
  stderr?: (chunk: string) => void; // diagnostics callback; stdout frames never route here (WS-04 §6)
  maxBufferSize?: number;           // bounds an unterminated protocol line (WS-04 §2); default is provisional, see transport.ts
  // DEVIATION beyond the brief's literal Options-additions list (pathToClaudeCodeExecutable /
  // spawnClaudeCodeProcess / stderr / maxBufferSize): WS-04 §6 says "the consumer's AbortSignal
  // propagates: wrapper → control-level cancel, then kill on non-compliance", which presupposes a
  // consumer-facing cancellation input — Query.interrupt() is a control request, not kill/abort
  // (WS-04 §5), and stays a stub until Task 3's state machine. Recorded here as an Open
  // question/deviation in the Task 2 report: unverified against the pinned 0.3.250 declaration
  // (fetching it to check was ruled out of this task's scope) — a future snapshot pass may need to
  // rename or reshape this field.
  abortController?: AbortController;

  // --- Task 9 (WS-05 §7): continue / resume / fork / resume-at. Pure passthrough into
  // RuntimeConfig's already-declared fields (packages/sdk/src/protocol/config.ts — pre-declared
  // since Task 2) via query.ts's --config-json serialization; the actual resolution against the
  // transcript store happens runtime-side (packages/runtime/src/store/resume.ts +
  // dialect.ts's resolveEngineSession), never in this package (WS-02 §3: the sdk never imports the
  // runtime).
  sessionId?: string; // pre-allocate this run's session id instead of an auto-generated uuid; round-trips into the init frame's sessionId and the transcript filename.
  continue?: boolean; // resume the newest session in the current directory (WS-05 §7).
  resume?: string; // resume this session id — current project first, then every other project; an ambiguous foreign match is a typed refusal, never an arbitrary pick.
  forkSession?: boolean; // combined with continue/resume: copy the resolved target into a fresh session id FIRST, then resume the copy — the original transcript is left untouched.
  resumeSessionAt?: string; // load only through this message uuid (the transcript is a graph, not a linear buffer — the tail is never deleted, just not part of this run's context).
  resumeDropsTurn?: boolean; // confirms resumeSessionAt is intentionally discarding entries after the target uuid; validated runtime-side, never a blind trust flag.
  persistSession?: boolean; // false suppresses transcript persistence entirely; excluded from every resume surface (WS-05 §7).
}
