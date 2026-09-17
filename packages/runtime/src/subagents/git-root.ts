// Spawn-surface parity (research §A5, gap 8): "is this directory inside a git repository?" -- the one
// question the Agent tool's SILENT remote fallback needs (remote -> a worktree when a git root
// exists, else a plain local agent).
//
// A standalone, side-effect-free probe on purpose: `subagents/workspace.ts` reaches git through
// `tools/impl/enter-worktree.ts`, and an executor module importing another executor module registers
// that other tool as a side effect (tools/impl-isolation.test.ts). The Agent executor must not pull
// EnterWorktree in with it.
import { spawn } from "node:child_process";

export function hasGitRoot(cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const child = spawn("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: ["ignore", "ignore", "ignore"] });
      child.on("error", () => done(false));
      child.on("close", (code) => done(code === 0));
    } catch {
      done(false);
    }
  });
}
