// WS-23 item 2: the transcript carries claude's own `effort`/`perTurnEffort` assistant-entry fields,
// resume carries them back onto the rebuilt messages, and a resumed session derives its effort
// markers at exactly the positions the live session sent them -- which is what keeps the cached
// prefix matching across a resume. Old transcripts without the fields replay unchanged.
import { describe, expect, test } from "bun:test";
import type { SessionStoreEntry, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { assistantEntry, userEntry, type SessionCtx } from "./dialect.ts";
import { rebuildProviderMessages, toDialectEntries } from "./resume.ts";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, type ContentBlock, type EngineOptions, type ModelDescription, type ProviderMessage, type ProviderRequest } from "../engine.ts";
import { stubExecutor } from "../provider/mock.ts";
import { toWireMessages } from "../../../provider-runtime/src/adapters/anthropic/messages.ts";

const ctx: SessionCtx = { sessionId: "s-effort", cwd: "/winter-fixture", version: "0" };

describe("the assistant entry's effort fields (WS-23 item 2)", () => {
  test("written as TOP-LEVEL entry fields, where claude 2.1.282 writes them", () => {
    const entry = assistantEntry({ content: [{ type: "text", text: "hi" }], chain: { parentUuid: null }, ctx, effort: "high", perTurnEffort: "low" }) as Record<string, unknown>;
    expect(entry["effort"]).toBe("high");
    expect(entry["perTurnEffort"]).toBe("low");
    expect(entry["message"]).not.toHaveProperty("effort");
  });

  test("an entry written without them carries no such keys at all (byte-identical to before)", () => {
    const entry = assistantEntry({ content: [{ type: "text", text: "hi" }], chain: { parentUuid: null }, ctx });
    expect(Object.keys(entry)).not.toContain("effort");
    expect(Object.keys(entry)).not.toContain("perTurnEffort");
  });

  test("resume carries them onto the rebuilt assistant message; an old entry rebuilds unchanged; claude's `perTurnEffort: null` is not a level", () => {
    const u = userEntry({ text: "q", chain: { parentUuid: null }, ctx });
    const a = assistantEntry({ content: [{ type: "text", text: "a" }], chain: { parentUuid: u.uuid }, ctx, effort: "high", perTurnEffort: "low" });
    const u2 = userEntry({ text: "q2", chain: { parentUuid: a.uuid }, ctx });
    const old = assistantEntry({ content: [{ type: "text", text: "b" }], chain: { parentUuid: u2.uuid }, ctx });
    const u3 = userEntry({ text: "q3", chain: { parentUuid: old.uuid }, ctx });
    const claudeWritten = { ...assistantEntry({ content: [{ type: "text", text: "c" }], chain: { parentUuid: u3.uuid }, ctx }), effort: "max", perTurnEffort: null };
    const rebuilt = rebuildProviderMessages(toDialectEntries([u, a, u2, old, u3, claudeWritten] as unknown as SessionStoreEntry[]));
    expect(rebuilt[1]).toEqual({ role: "assistant", content: "a", uuid: a.uuid, effort: "high", perTurnEffort: "low" });
    expect(rebuilt[3]).toEqual({ role: "assistant", content: "b", uuid: old.uuid });
    expect(rebuilt[5]).toEqual({ role: "assistant", content: "c", uuid: claudeWritten.uuid, effort: "max" });
  });
});

// --- live vs resumed: the markers land at the same positions ---------------------------------------

const OPUS_55: ModelDescription = { efforts: ["low", "medium", "high", "xhigh", "max"], wire: { perMessageEffort: true } };

type Step = { user: string } | { effort: string };

/** Drives the engine with a store double built from the REAL dialect builders, and returns the requests and the transcript it wrote. */
async function run(steps: Step[], initialMessages?: ProviderMessage[]): Promise<{ requests: ProviderRequest[]; entries: SessionStoreEntry[] }> {
  const requests: ProviderRequest[] = [];
  const entries: SessionStoreEntry[] = [];
  let parent: string | null = null;
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({
    config: { sessionId: "s-effort", cwd: "/winter-fixture", model: "anthropic/claude-opus-5-5", effort: "high" },
    input: runtime.input,
    output: runtime.output,
    provider: {
      async generate(req) {
        requests.push({ ...req, messages: structuredClone(req.messages) });
        return { kind: "text", text: `reply ${requests.length}` };
      },
    },
    tools: stubExecutor,
    providerIdentity: { providerId: "anthropic", modelKey: "anthropic/claude-opus-5-5", family: "anthropic" },
    describeModel: () => OPUS_55,
    ...(initialMessages !== undefined ? { initialMessages } : {}),
    store: {
      recordUserEntry(content: string | ContentBlock[]) {
        const e = typeof content === "string" ? userEntry({ text: content, chain: { parentUuid: parent }, ctx }) : userEntry({ content, chain: { parentUuid: parent }, ctx });
        entries.push(e as unknown as SessionStoreEntry);
        parent = e.uuid;
      },
      recordAssistantEntry(content: ContentBlock[], opts?: { uuid?: string; effort?: string; perTurnEffort?: string }) {
        const e = assistantEntry({ content, chain: { parentUuid: parent }, ctx, ...(opts ?? {}) });
        entries.push(e as unknown as SessionStoreEntry);
        parent = e.uuid;
      },
    },
  } as EngineOptions);
  const frames: WinterFrame[] = [];
  const reader = (async () => {
    for await (const f of host.input) frames.push(f);
  })();
  const results = (): number => frames.filter((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result").length;
  let users = 0;
  let controls = 0;
  for (const step of steps) {
    if ("user" in step) {
      host.output.write({ type: "user", text: step.user });
      users++;
      for (let n = 0; n < 2000 && results() < users; n++) await new Promise((r) => setTimeout(r, 2));
    } else {
      const requestId = `e${++controls}`;
      host.output.write({ type: "control_request", requestId, subtype: "set_effort", payload: { effort: step.effort } });
      for (let n = 0; n < 2000 && !frames.some((f) => f.type === "control_response" && (f as { requestId: string }).requestId === requestId); n++) await new Promise((r) => setTimeout(r, 2));
    }
  }
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  await done;
  await reader;
  return { requests, entries };
}

describe("a resumed session re-derives the live session's effort markers (WS-23 item 2)", () => {
  test("turn three after a resume is byte-identical to turn three of the uninterrupted session", async () => {
    const live = await run([{ user: "one" }, { effort: "low" }, { user: "two" }, { effort: "high" }, { user: "three" }]);
    // Resume from the transcript as it stood after turn two, then ask turn three at the session's own `high`.
    const firstTwo = live.entries.slice(0, 4);
    const resumedHistory = rebuildProviderMessages(toDialectEntries(firstTwo));
    const resumed = await run([{ user: "three" }], resumedHistory);
    expect(resumed.requests[0]!.effort).toBe(live.requests[2]!.effort);
    // Compared as the Anthropic adapter serialises them: the in-memory `origin` annotation differs (a
    // real resume re-attaches it from the provider-state sidecar), but it never reaches the wire.
    expect(JSON.stringify(toWireMessages(resumed.requests[0]!.messages))).toBe(JSON.stringify(toWireMessages(live.requests[2]!.messages)));
    // And the markers are really there: the leading one at the frozen `high`, `low` before `two`, `high` before `three`.
    expect(resumed.requests[0]!.messages.filter((m) => m.role === "system").map((m) => m.outputConfig?.effort)).toEqual(["high", "low", "high"]);
  });
});
