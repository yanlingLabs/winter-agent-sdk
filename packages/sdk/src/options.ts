import type { WinterFrame } from "./protocol/frames.ts";

// Structural, not the runtime's `Duplex` by name (the sdk cannot import the runtime, WS-02 §3):
// any transport whose input/output speak WinterFrame satisfies this. Task 2 removes spawnRuntime
// entirely in favor of the byte-level SpawnClaudeCodeProcess seam, so this shape is transitional.
export type SpawnRuntime = (ctx: { cwd: string; model: string; env: Record<string, string> }) => {
  input: AsyncIterable<WinterFrame>;
  output: { write(f: WinterFrame): void; end(): void };
};

export interface Options {
  model?: string;
  permissionMode?: string;          // full union arrives with WS-07; P0 accepts any string
  maxTurns?: number;
  cwd?: string;
  env?: Record<string, string>;     // REPLACES the child env (WS-03 §5); P0 records it only
  spawnRuntime?: SpawnRuntime;       // WS-04 §8 seam; no default until a runtime transport is configured (Task 2)
}
