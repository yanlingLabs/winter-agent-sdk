/** Test harness (not shipped behaviour): drives `inMemoryProcess` with the held-input journal at the FRAME level, so a test can send the
 * four `host_input_*` verbs, read their answers, kill the process mid-turn and start a second one on the same home and session. */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFrame, splitFrames, type WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { inMemoryProcess } from "../testing.ts";
import type { Provider, ProviderRequest, ToolExecutor } from "../engine.ts";

export const EPOCH = { incarnationId: "inc-1", leaseEpoch: 1 } as const;
export const tokenOf = (label: string): string => Bun.CryptoHasher.hash("sha256", `hold-v1|${label}`, "hex");
export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export interface Gate { promise: Promise<void>; open(): void }
export function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

export interface GuestOptions {
  home: string;
  cwd: string;
  sessionId?: string;
  resume?: boolean;
  /** Scripted model: each call sees the request; default answers "ok". A `tool` reply makes one Write call first. */
  script?: (request: ProviderRequest, call: number) => { tool?: true; text?: string };

  /** The Write executor: resolves when the gate opens (so a turn stays running). */
  toolGate?: Gate;
  epoch?: { incarnationId: string; leaseEpoch: number };
}

export function tempRoot(label: string): { home: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), `winter-held-${label}-`));
  const home = join(root, "home"), cwd = join(root, "cwd");
  mkdirSync(home); mkdirSync(cwd);
  return { home, cwd };
}

export function startGuest(options: GuestOptions) {
  const sessionId = options.sessionId ?? "11111111-1111-4111-8111-111111111111";
  const requests: ProviderRequest[] = [];
  let calls = 0;
  const provider: Provider = {
    async generate(request) {
      requests.push(request);
      const plan: { tool?: true; text?: string } = (options.script ?? (() => ({ text: "ok" })))(request, calls++);
      if (plan.tool === true) return { kind: "tool_use", calls: [{ id: `tool-${calls}`, name: "Write", input: { file_path: join(options.cwd, "f"), content: "x" } }] };
      return { kind: "text", text: plan.text ?? "ok" };
    },
  };
  const toolRuns: number[] = [];
  const tools: ToolExecutor = { async execute() { toolRuns.push(1); await options.toolGate?.promise; return { output: "done" }; } };
  const config = {
    sessionId, cwd: options.cwd, model: "winter-test/echo", persistSession: true, winterHome: options.home, permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true, sandbox: { enabled: false }, ...(options.resume === true ? { resume: sessionId } : {}),
  };
  const proc = inMemoryProcess(["--run", "--config-json", JSON.stringify(config)], provider, tools, { WINTER_HOME: options.home }, options.epoch ?? EPOCH);
  const frames: WinterFrame[] = [];
  const waiters: Array<() => void> = [];
  let alive = true;
  void (async () => {
    let carry = "";
    for await (const chunk of proc.stdout) {
      const split = splitFrames(chunk, carry);
      carry = split.carry;
      frames.push(...split.frames);
      for (const wake of waiters.splice(0)) wake();
    }
    alive = false;
    for (const wake of waiters.splice(0)) wake();
  })();
  const send = (frame: Record<string, unknown>): void => proc.stdin.write(encodeFrame(frame as unknown as WinterFrame));
  async function waitFor<T>(find: () => T | undefined, what: string, ms = 8000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = find();
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; frames: ${JSON.stringify(frames.map(f => [f.type, (f as { subtype?: string }).subtype ?? (f as { message?: { type?: string; subtype?: string } }).message?.subtype ?? (f as { message?: { type?: string } }).message?.type]))}`);
      await new Promise<void>(resolve => { waiters.push(resolve); setTimeout(resolve, 50); });
      if (!alive && find() === undefined) throw new Error(`process ended while waiting for ${what}`);
    }
  }
  let counter = 0;
  async function control(subtype: string, payload: unknown): Promise<{ ok: boolean; payload?: any; error?: { code: string; message: string } }> {
    const requestId = `req-${++counter}`;
    send({ type: "control_request", requestId, subtype, payload });
    const response = await waitFor(() => frames.find(f => f.type === "control_response" && (f as { requestId?: string }).requestId === requestId), `response to ${subtype}`);
    return response as never;
  }
  const system = (subtype: string): Array<Record<string, any>> => frames.filter(f => f.type === "data" && (f as any).message?.type === "system" && (f as any).message?.subtype === subtype).map(f => (f as any).message);
  const results = (): WinterFrame[] => frames.filter(f => f.type === "data" && (f as any).message?.type === "result");
  const hold = (inputId: string, label: string, text = `message ${inputId}`, epoch: unknown = options.epoch ?? EPOCH) => control("host_input_hold", { inputId, holdToken: tokenOf(label), epoch, text, clientName: "peer" });
  const commit = (inputId: string, label: string) => control("host_input_commit", { inputId, holdToken: tokenOf(label) });
  const discard = (inputId: string, label: string) => control("host_input_discard", { inputId, holdToken: tokenOf(label) });
  const forget = (inputId: string, label: string) => control("host_input_forget", { inputId, holdToken: tokenOf(label) });
  return {
    proc, frames, requests, toolRuns, send, control, waitFor, system, results, hold, commit, discard, forget, sessionId,
    kill() { proc.kill(); },
    async end() { send({ type: "control_request", requestId: "end", subtype: "end_input" }); proc.stdin.end(); await proc.exited; },
    texts(): string[] { return requests.map(request => JSON.stringify(request.messages)); },
  };
}
export type Guest = ReturnType<typeof startGuest>;

/** Every file under `root` named `name`, and every .jsonl transcript. */
export function filesUnder(root: string, match: (name: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (match(entry)) out.push(path);
    }
  };
  walk(root);
  return out;
}
export const journalPath = (home: string): string | undefined => filesUnder(home, name => name === "held-inputs.json")[0];
export const journalRecords = (home: string): Array<Record<string, any>> => {
  const path = journalPath(home);
  return path === undefined ? [] : JSON.parse(readFileSync(path, "utf8")).records;
};
/** The transcript lines (parsed) that mention this inputId. */
export const transcriptLinesFor = (home: string, inputId: string): Array<Record<string, any>> =>
  filesUnder(home, name => name.endsWith(".jsonl")).flatMap(path => readFileSync(path, "utf8").split("\n").filter(line => line.includes(`"${inputId}"`)).map(line => JSON.parse(line)));
