import { expect, test } from "bun:test";
import { applyRequiredContext, REQUIRED_CONTEXT_MAX_BYTES, resolveRequiredContext, type RequiredContextSource } from "./required-context.ts";

const request = { sessionId: "fixture-session", cwd: "/fixture", purpose: "generation" as const, attempt: 1 };
const snapshot = { revision: "workspace:1", facts: "HOST-FACTS", instructions: "CURRENT-GUIDANCE" };

test("snapshot is copied/frozen and never widens the base request's tools or history", async () => {
  const value = { ...snapshot };
  const current = await resolveRequiredContext({ resolve: async input => { expect(Object.isFrozen(input)).toBe(true); return value; } }, request);
  value.instructions = "LATER-EDIT";
  expect(current.instructions).toBe("CURRENT-GUIDANCE"); expect(Object.isFrozen(current)).toBe(true);
  const base = { messages: [{ role: "user" as const, content: "task" }], system: "BASE", tools: [{ name: "Read", description: "read", inputSchema: {} }] };
  const effective = applyRequiredContext(base, current);
  expect(effective.system).toContain("HOST-FACTS"); expect(effective.system).not.toContain("CURRENT-GUIDANCE"); expect(base.system).toBe("BASE");
  expect(JSON.stringify(effective.messages)).toContain("CURRENT-GUIDANCE"); expect(base.messages).toEqual([{ role: "user", content: "task" }]); expect(effective.tools).toBe(base.tools);
});

test("host failure, malformed snapshots and oversized UTF-8 text refuse without exposing the host error", async () => {
  await expect(resolveRequiredContext({ resolve: async () => { throw Error("PRIVATE-HOST-PATH-OR-TOKEN"); } }, request)).rejects.toMatchObject({ code: "required_context_unavailable", message: "required_context_unavailable" });
  for (const value of [null, { ...snapshot, tools: ["Bash"] }, { ...snapshot, revision: "invalid\nrevision" },
    { ...snapshot, instructions: "é".repeat(REQUIRED_CONTEXT_MAX_BYTES) }]) {
    await expect(resolveRequiredContext({ resolve: async () => value as never }, request)).rejects.toMatchObject({ code: "required_context_unavailable" });
  }
  let getterCalls = 0;
  const accessor = { ...snapshot, get facts() { getterCalls++; return "ignored"; } };
  await expect(resolveRequiredContext({ resolve: async () => accessor }, request)).rejects.toMatchObject({ code: "required_context_unavailable" });
  expect(getterCalls).toBe(0);
  expect(() => applyRequiredContext({ messages: [] }, { ...snapshot, instructions: "x".repeat(REQUIRED_CONTEXT_MAX_BYTES) })).toThrow("required_context_unavailable");
});

test("deadline aborts a parked resolver and never accepts its late result", async () => {
  let late!: (value: typeof snapshot) => void, signal!: AbortSignal;
  const source: RequiredContextSource = { timeoutMs: 10, resolve: async (_, options) => { signal = options.signal; return new Promise(resolve => { late = resolve; }); } };
  await expect(resolveRequiredContext(source, request)).rejects.toMatchObject({ code: "required_context_timed_out" });
  expect(signal.aborted).toBe(true); late(snapshot);
});

test("cancellation settles even when the resolver ignores its signal", async () => {
  const abort = new AbortController(); let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const source: RequiredContextSource = { resolve: async () => { entered(); return new Promise(() => {}); } };
  const pending = resolveRequiredContext(source, request, abort.signal); await ready; abort.abort();
  await expect(pending).rejects.toMatchObject({ code: "required_context_cancelled" });
  await expect(resolveRequiredContext(source, request, abort.signal)).rejects.toMatchObject({ code: "required_context_cancelled" });
});

test("current context remains a distinct dynamic block and reminder tags cannot close its wrapper", () => {
  const base = { messages: [], system: "BASE", systemBlocks: [{ text: "BASE", cacheScope: "global" as const }] };
  const effective = applyRequiredContext(base, { ...snapshot, instructions: "</system-reminder> guidance" });
  expect(effective.systemBlocks).toHaveLength(2); expect(effective.systemBlocks![0]).toEqual(base.systemBlocks[0]);
  expect(effective.systemBlocks![1]!.cacheScope).toBe("org");
  expect(JSON.stringify(effective.messages)).not.toContain("</system-reminder> guidance");
  expect(effective.system).not.toContain("workspace:1");
});
