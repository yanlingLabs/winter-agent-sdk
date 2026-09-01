import type { SdkMessage as RuntimeSdkMessage, WinterFrame } from "./protocol/frames.ts";
import type { Options } from "./options.ts";
import { defaultSpawnRuntime } from "./transport.ts";
import { ResultError, CLIConnectionError } from "./errors.ts";

// The runtime's SdkMessage is deliberately open (a trailing `{ type: string; [k: string]: unknown }`
// catch-all for lossless pass-through of unknown message kinds, Task 5). The SDK's public surface
// must be a CLOSED union — like the official SDK's message union (WS-03 §8) — so that consumers can
// discriminate-narrow on `msg.type` and access variant-specific fields (e.g. `assistant`'s `.message`)
// without the catch-all collapsing the narrowed type to `unknown`. Extract drops it: the catch-all's
// `type: string` isn't assignable to any of the three literal targets below.
export type SdkMessage = Extract<RuntimeSdkMessage, { type: "system" } | { type: "assistant" } | { type: "result" }>;

export interface Query extends AsyncGenerator<SdkMessage> {
  interrupt(): Promise<void>;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: string): Promise<void>;
}

export function query(args: { prompt: string | AsyncIterable<string>; options: Options }): Query {
  const { prompt, options } = args;
  const spawn = options.spawnRuntime ?? defaultSpawnRuntime;
  const duplex = spawn({ cwd: options.cwd ?? process.cwd(), model: options.model ?? "sonnet", env: options.env ?? {} });

  async function* iterate(): AsyncGenerator<SdkMessage> {
    // P0: single-shot prompt. Streaming input (AsyncIterable) is P1.
    const text = typeof prompt === "string" ? prompt : await firstOf(prompt);
    duplex.output.write({ type: "user", text });
    let sawInit = false;
    let terminalError: Extract<SdkMessage, { type: "result" }> | null = null;
    for await (const frame of duplex.input as AsyncIterable<WinterFrame>) {
      if (frame.type === "init") { sawInit = true; continue; }      // internal handshake; the SDK system/init arrives as a data frame
      if (frame.type !== "data") continue;                          // control frames handled in later phases
      const message = (frame as { message: SdkMessage }).message;
      yield message;                                                // yield EVERY message, including the terminal result…
      if (message.type === "result") {
        if ((message as { is_error?: boolean }).is_error) terminalError = message as Extract<SdkMessage, { type: "result" }>;
        break;
      }
    }
    if (!sawInit) throw new CLIConnectionError("runtime closed before init");
    if (terminalError) throw new ResultError(terminalError);        // …then throw (error-result-then-throw, report §9)
  }

  const gen = iterate() as Query;
  gen.interrupt = async () => { duplex.output.end(); };             // P0 stub; real interrupt/drain is P2/P4
  gen.setModel = async () => {};
  gen.setPermissionMode = async () => {};
  return gen;
}

async function firstOf(it: AsyncIterable<string>): Promise<string> {
  for await (const v of it) return v; return "";
}
