import type { FrameSource, FrameSink } from "./protocol/channel.ts";
import type { RuntimeConfig } from "@yanlinglabs/winter-agent-sdk";
import { runEngine, type Provider, type ToolExecutor, type SessionPersistence } from "./engine.ts";
import { stubExecutor } from "./provider/mock.ts";

// Thin compatibility adapter over runEngine (Task 3 ledger: kept, rather than deleted, because the
// P0-era flat-args call shape — sessionId/cwd/model instead of a RuntimeConfig — is still how
// runtime.test.ts and this package's index.ts barrel expose a "just run it" entry point; the real
// production entry point is Task 4's main.ts, which calls runEngine directly).
//
// Provider's shape changed from prompt-based (`generate({prompt})`) to messages-based
// (`generate({messages})`) in Task 3, to support multi-turn accumulation and tool rounds — that
// change is NOT shimmed away here. runtime.test.ts's two P0 tests were migrated onto the new
// Provider shape (a one-line return-type change each) rather than this adapter keeping the old
// shape alive: maintaining two parallel Provider interfaces indefinitely for a 2-test legacy
// surface costs more than that one-line test diff (ledgered in the task-3 report).
//
// The old `tools?: string[]` field (tool-catalog names for the init frame) is dropped: it was never
// exercised by any caller, and engine.ts hardcodes an empty init tool list at P1 (no catalog until
// WS-06) — keeping a parameter that would now silently do nothing is worse than not accepting it.
// `tools` is repurposed for the new ToolExecutor capability instead.
export async function runWinterRuntime(opts: {
  input: FrameSource; output: FrameSink; provider: Provider;
  sessionId: string; cwd: string; model: string; permissionMode?: string;
  maxTurns?: number; tools?: ToolExecutor; store?: SessionPersistence;
}): Promise<void> {
  const config: RuntimeConfig = {
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    model: opts.model,
    ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
    ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
  };
  await runEngine({
    config,
    input: opts.input,
    output: opts.output,
    provider: opts.provider,
    tools: opts.tools ?? stubExecutor,
    ...(opts.store !== undefined ? { store: opts.store } : {}),
  });
}
