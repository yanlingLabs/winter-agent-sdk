import type { Provider, ProviderTurn, ToolExecutor } from "../engine.ts";

// Task 3 moved Provider from prompt-based (`generate({prompt}): Promise<{text}>`) to
// messages-based (`generate({messages}): Promise<ProviderTurn>`) to support multi-turn
// accumulation and tool rounds. echoProvider is kept byte-compatible with its old behavior — echo
// the latest user turn's text — so the differential golden (which pins this provider's output)
// stays unchanged; it just reads that text out of the accumulated history instead of a single
// `{prompt}` field.
export const echoProvider: Provider = {
  async generate({ messages }) {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const text = typeof lastUser?.content === "string" ? lastUser.content : "";
    return { kind: "text", text: `echo: ${text}` };
  },
};

// Pops one scripted turn per generate() call, in the array's given order. Throws once exhausted
// (a scripted conversation that ran longer than scripted is a test bug, not a silent echo).
export function scriptedProvider(turns: ProviderTurn[]): Provider {
  const queue = [...turns];
  return {
    async generate() {
      const next = queue.shift();
      if (!next) throw new Error("scriptedProvider: no more scripted turns");
      return next;
    },
  };
}

// Deterministic, dependency-free tool double: echoes `${name}:${JSON.stringify(input)}`.
export const stubExecutor: ToolExecutor = {
  async execute({ name, input }) {
    return { output: `${name}:${JSON.stringify(input)}` };
  },
};
