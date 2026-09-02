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

// --- P1 test-only provider selection (env WINTER_TEST_PROVIDER) --------------------------------
//
// Task 4: the CHILD leg of the transport-equivalence suite is a real spawned process — it cannot
// take an in-process scripted Provider function the way inMemoryProcess can. This is the shared
// selector both main.ts (reads process.env.WINTER_TEST_PROVIDER) and
// packages/sdk/src/transport-equivalence.test.ts (calls this directly for the in-memory leg, and
// sets the env var for the child leg) call — ONE definition, imported by both call sites, so the
// two legs are byte-identical by construction rather than two hand-copies that could quietly
// drift apart. This is a documented P1 test affordance, not part of the wire protocol or any
// production surface: remove alongside main.ts's env read once real providers land (P6).
// Task 9: "reflect" answers every generate() call with a JSON-encoded copy of the exact messages
// it received — the only way a resume equivalence scenario can observe "did this run's provider
// actually see the prior turns" from OUTSIDE a real child/compiled process (transport-
// equivalence.test.ts's resume scenario uses it on all three legs, via this SAME selector).
// Task 2: "rpcprobe" joins this family — a single scripted turn that returns the engine's
// "rpc_probe" ProviderTurn kind (engine.ts), proving the runtime-originated control-RPC bridge
// round trip (WS-04 §3.1) identically on every transport leg (transport-equivalence.test.ts's
// rpcprobe scenario is its only consumer). REMOVE at P6 alongside the rest of this file.
export type TestProviderName = "boom" | "tooluse" | "hang" | "reflect" | "rpcprobe" | "modeswitch";

export function isTestProviderName(v: string): v is TestProviderName {
  return v === "boom" || v === "tooluse" || v === "hang" || v === "reflect" || v === "rpcprobe" || v === "modeswitch";
}

export function testProviderByName(name: TestProviderName): Provider {
  switch (name) {
    // error-result-then-throw fixture (WS-03 §11 / report §9): a provider that always throws,
    // so the engine's catch-and-convert-to-error-result path is reachable from a real child too.
    case "boom":
      return {
        async generate() {
          throw new Error("boom: WINTER_TEST_PROVIDER=boom scripted failure");
        },
      };
    // One tool_use round, then text — deterministic and dependency-free (paired with the engine's
    // always-on stubExecutor). Built fresh per call: scriptedProvider's queue is consumed as it's
    // used, so a fresh instance per process/test keeps repeated selection from sharing state.
    case "tooluse":
      return scriptedProvider([
        { kind: "tool_use", calls: [{ id: "test-call-1", name: "test_tool", input: { probe: true } }] },
        { kind: "text", text: "tool round done" },
      ]);
    // Never resolves — puts the engine into a genuinely in-flight state (blocked inside
    // provider.generate()) so a later interrupt/kill/abort has something real to act on (WS-04
    // §5/§6), on a leg (a real child) that has no other way to synchronize with engine-internal
    // timing the way an in-process test double's callback can.
    case "hang":
      return {
        async generate(): Promise<ProviderTurn> {
          return new Promise(() => {});
        },
      };
    // Reflects the exact ProviderMessage[] it was called with back as its text reply, JSON-encoded.
    // A resumed run's reflected text therefore contains the prior run's own (possibly itself
    // reflected) text nested inside it — assert containment against the parsed array, not a fixed
    // string, since the second run's payload is not equal to the first run's in isolation.
    case "reflect":
      return {
        async generate({ messages }) {
          return { kind: "text", text: JSON.stringify(messages) };
        },
      };
    // Task 2 (WS-04 §3.1): a single scripted turn returning the "rpc_probe" ProviderTurn kind —
    // the ENGINE (not this provider) performs bridge.request(subtype, payload) and embeds the
    // host's answer in the final reply (engine.ts's round loop). This provider never touches the
    // bridge itself: it just hands the engine the subtype/payload to send, the same way "tooluse"
    // hands the engine calls to execute.
    case "rpcprobe":
      return {
        async generate() {
          return { kind: "rpc_probe", subtype: "test_rpc_probe", payload: { probe: "ping" } };
        },
      };
    // Task 13 (WS-07 §2 / §12 "stale-policy-version"): a fixed 4-step script for a two-ROUND
    // mode-switch scenario -- turn 1 (round A) needs its own tool_use + text, turn 2 (round B, run
    // under a DIFFERENT live-switched mode) needs a SECOND, otherwise-identical tool_use + text.
    // "tooluse"'s own 2-step script is exhausted after one round (scriptedProvider throws once its
    // queue is empty), so it cannot serve a second round -- this is a plain extension of the same
    // fixed-script idiom (identical to why "rpcprobe" exists), needed because the CHILD/compiled
    // transport-equivalence legs can only select a provider by name, never an in-process closure.
    case "modeswitch":
      return scriptedProvider([
        { kind: "tool_use", calls: [{ id: "c1", name: "mystery_tool", input: {} }] },
        { kind: "text", text: "first done" },
        { kind: "tool_use", calls: [{ id: "c2", name: "mystery_tool", input: {} }] },
        { kind: "text", text: "second done" },
      ]);
  }
}
