import type { Duplex } from "winter-agent-runtime";
export type SpawnRuntime = (ctx: { cwd: string; model: string; env: Record<string, string> }) => Duplex;
export interface Options {
  model?: string;
  permissionMode?: string;          // full union arrives with WS-07; P0 accepts any string
  maxTurns?: number;
  cwd?: string;
  env?: Record<string, string>;     // REPLACES the child env (WS-03 §5); P0 records it only
  spawnRuntime?: SpawnRuntime;       // WS-04 §8 seam; default = in-memory
}
