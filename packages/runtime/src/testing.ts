import type { SpawnedRuntimeProcess, RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { encodeFrame, splitFrames } from "@yanlinglabs/winter-agent-sdk";
import { Queue } from "./protocol/channel.ts";
import type { FrameSource, FrameSink } from "./protocol/channel.ts";
import { runWinterRuntime } from "./runtime.ts";
import { echoProvider, type Provider } from "./provider/mock.ts";

function parseConfigFromArgv(argv: string[]): RuntimeConfig {
  const idx = argv.indexOf("--config-json");
  const raw = idx === -1 ? undefined : argv[idx + 1];
  if (raw === undefined) throw new Error("inMemoryProcess: argv is missing '--config-json <json>'");
  return JSON.parse(raw) as RuntimeConfig;
}

// Byte-level virtual process (WS-04 §1.1): boots the current runWinterRuntime behind the SAME
// codec path a real spawned `winter` child will use (Task 4) — engine WinterFrames encode to
// stdout text chunks via encodeFrame, stdin text chunks decode to WinterFrames via splitFrames —
// so the in-memory and child transports can never diverge on framing (WS-04 §1). Parses the same
// `--config-json` argv contract the future real binary parses; only sessionId/cwd/model are
// consumed today (Ruling P1-A) — the remaining RuntimeConfig fields (resume/continue/fork/...)
// are inert until the turn engine (Task 3) and resume machinery (Task 9) land.
//
// Replaces P0's object-level inMemorySpawn (deleted with the spawnRuntime option it served).
export function inMemoryProcess(argv: string[], provider: Provider = echoProvider): SpawnedRuntimeProcess {
  const config = parseConfigFromArgv(argv);

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

  void runWinterRuntime({ input, output, provider, sessionId: config.sessionId, cwd: config.cwd, model: config.model })
    .then(() => {
      if (!settled) {
        settled = true;
        settleExited({ code: 0, signal: null });
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
