import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnedRuntimeProcess, RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { encodeFrame, splitFrames } from "@yanlinglabs/winter-agent-sdk";
import { Queue } from "./protocol/channel.ts";
import type { FrameSource, FrameSink } from "./protocol/channel.ts";
import { runEngine, type Provider, type ToolExecutor } from "./engine.ts";
import { echoProvider, stubExecutor } from "./provider/mock.ts";
import { createTranscriptPersistence } from "./store/dialect.ts";

// inMemoryProcess is a TESTING-ONLY entry point (winter-agent-runtime/testing — never used by real
// production code; main.ts is the real entrypoint) — so unlike main.ts's resolveProductionWinterHome,
// which correctly falls all the way back to the real user's ~/.winter, this resolver must NEVER
// reach that fallback: `config.winterHome` wins if set; otherwise a non-blank `env.WINTER_HOME`
// (the HARD CONSTRAINT's injection point — see transport-equivalence.test.ts's spawnHook and
// scripts/differential.ts, which relies on omitting BOTH to land here); otherwise a fresh per-call
// mkdtemp. It never even LOOKS at process.env, let alone falls through to resolveWinterHome's
// homedir default — every caller of inMemoryProcess that doesn't explicitly opt in is safe by
// construction, including test files this task never had to touch.
function resolveInMemoryWinterHome(config: RuntimeConfig, env: Record<string, string | undefined> | undefined): string {
  if (config.winterHome !== undefined) return config.winterHome;
  const override = env?.WINTER_HOME;
  if (override !== undefined && override.trim() !== "") return override;
  return mkdtempSync(join(tmpdir(), "winter-inmemory-"));
}

function parseConfigFromArgv(argv: string[]): RuntimeConfig {
  const idx = argv.indexOf("--config-json");
  const raw = idx === -1 ? undefined : argv[idx + 1];
  if (raw === undefined) throw new Error("inMemoryProcess: argv is missing '--config-json <json>'");
  return JSON.parse(raw) as RuntimeConfig;
}

// Byte-level virtual process (WS-04 §1.1): boots runEngine behind the SAME codec path a real
// spawned `winter` child will use (Task 4) — engine WinterFrames encode to stdout text chunks via
// encodeFrame, stdin text chunks decode to WinterFrames via splitFrames — so the in-memory and
// child transports can never diverge on framing (WS-04 §1). Parses the same `--config-json` argv
// contract the future real binary parses, and (Task 3) now hands the ENGINE the full parsed
// RuntimeConfig — not just sessionId/cwd/model — so maxTurns/permissionMode/etc. all flow through;
// the remaining fields (resume/continue/fork/...) stay inert until resume machinery (Task 9) reads
// them.
//
// Replaces P0's object-level inMemorySpawn (deleted with the spawnRuntime option it served).
//
// `env` (Task 8) controls ONLY where a persisted transcript lands when config.persistSession !==
// false (see resolveInMemoryWinterHome above) — it is NOT the child's process.env in any other
// sense (there is no real child process here). Omit it and persistence still activates by default
// (RuntimeConfig.persistSession defaults ON) but writes to an isolated, disposable temp directory,
// never a real shared path.
export function inMemoryProcess(
  argv: string[],
  provider: Provider = echoProvider,
  tools: ToolExecutor = stubExecutor,
  env?: Record<string, string | undefined>,
): SpawnedRuntimeProcess {
  const config = parseConfigFromArgv(argv);
  const store = createTranscriptPersistence({ config, resolveWinterHome: () => resolveInMemoryWinterHome(config, env) });

  const stdin = new Queue<string>();
  const stdout = new Queue<string>();

  const input: FrameSource = (async function* () {
    let carry = "";
    for await (const chunk of stdin) {
      const split = splitFrames(chunk, carry);
      carry = split.carry;
      for (const frame of split.frames) yield frame;
    }
  })();
  const output: FrameSink = {
    write(frame: WinterFrame) {
      stdout.write(encodeFrame(frame));
    },
    end() {
      stdout.end();
    },
  };

  let settleExited!: (v: { code: number | null; signal: string | null }) => void;
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    settleExited = resolve;
  });
  let settled = false;

  void runEngine({ config, input, output, provider, tools, ...(store !== undefined ? { store } : {}) })
    .then((code) => {
      if (!settled) {
        settled = true;
        settleExited({ code, signal: null });
      }
    })
    .catch(() => {
      if (!settled) {
        settled = true;
        settleExited({ code: 1, signal: null });
      }
    });

  return {
    stdin: {
      write(chunk: string) {
        stdin.write(chunk);
      },
      end() {
        stdin.end();
      },
    },
    stdout,
    kill(signal?: string) {
      if (settled) return;
      settled = true;
      // §1.1 ordering: end the stdout queue first (buffered frames still drain from an ended
      // Queue) — then resolve exited, so a consumer racing stdout against exited sees the
      // buffered data before/alongside the exit, never after it silently vanished.
      stdout.end();
      stdin.end(); // let the backgrounded engine terminate rather than leak
      settleExited({ code: null, signal: signal ?? "SIGTERM" });
    },
    exited,
    pid: null, // virtual handle — hosts MUST NOT require a PID (WS-04 §1.1)
  };
}
