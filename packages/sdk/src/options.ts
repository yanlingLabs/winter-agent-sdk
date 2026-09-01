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
}
