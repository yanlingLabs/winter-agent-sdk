import { expect, test } from "bun:test";
import { createGuestProviderClient, guestProviderFor, assertGuestProviderRoute, type GuestProviderScope } from "./provider-client.ts";
import { buildSessionProvider } from "../provider/session-provider.ts";
import { assertRuntimeExecutionPosture } from "./execution-posture.ts";
import type { ResolvedModel } from "@yanlinglabs/winter-provider-runtime";
const scope: GuestProviderScope = { homeId: "home", workspaceId: "workspace", sessionId: "logical", backendSessionId: "backend", taskId: "task", incarnationId: "incarnation", bootId: "boot", leaseEpoch: 1, grantRevision: 1, accountRevision: 1, modelRevision: 1 };
const selection = { providerId: "openai", modelKey: "openai/fixture", providerModelId: "fixture", family: "openai" as const, protocol: "openai-responses" as const, continuationDomain: "openai/fixture-domain", capabilities: { toolCalling: "native" as const, readableState: "summary" as const } };
const resolved = { providerId: "openai", modelKey: selection.modelKey, providerModelId: selection.providerModelId, continuationDomain: selection.continuationDomain, adapter: { family: "openai" } } as ResolvedModel;
function frame(value: unknown): Uint8Array { const body = Buffer.from(JSON.stringify(value)), result = Buffer.alloc(body.length + 4); result.writeUInt32BE(body.length); body.copy(result, 4); return result; }

test("actual SDK fold receives full native-state and tool trio over private byte framing", async () => {
  let calls = 0, closed = 0; const seen: unknown[] = [], events = [{ type: "native_state", items: [{ encrypted_content: "opaque" }] }, { type: "tool_call_start", id: "call", name: "Read" }, { type: "tool_call_delta", id: "call", argumentsJsonDelta: '{"file_path":"fixture"}' }, { type: "tool_call_end", id: "call" }, { type: "done", stopReason: "tool_use" }];
  const client = createGuestProviderClient({ scope, selection, port: { exchange: async bytes => { const request = JSON.parse(Buffer.from(bytes).subarray(4).toString()); seen.push(request); return frame({ version: 1, invocationId: request.invocationId, sequence: request.sequence, kind: request.operation === "begin" ? "accepted" : "event", ...(request.operation === "next" ? { event: events[calls++] } : {}) }); }, close: () => { closed++; } } });
  const turn = await guestProviderFor(client, resolved).generate({ messages: [{ role: "user", content: "hello" }] }); expect(turn.kind).toBe("tool_use"); if (turn.kind === "tool_use") expect(turn.calls).toEqual([{ id: "call", name: "Read", input: { file_path: "fixture" } }]); expect(turn.nativeState).toEqual({ family: "openai", continuationDomain: "openai/fixture-domain", items: [{ encrypted_content: "opaque" }] });
  expect(closed).toBe(0); expect(JSON.stringify(seen)).not.toContain("authRef"); client.close(); expect(closed).toBe(1);
});

test("forged binding, wrong model and logical/backend confusion cannot activate provider or credentials", () => {
  expect(() => guestProviderFor({ scope, selection, close() {} }, resolved)).toThrow("binding unavailable");
  const client = createGuestProviderClient({ scope, selection, port: { exchange: async () => { throw new Error("never"); }, close() {} } });
  expect(() => guestProviderFor(client, { ...resolved, modelKey: "openai/other" })).toThrow("selection mismatch");
  expect(() => buildSessionProvider({ config: { sessionId: scope.sessionId, cwd: "/never", model: selection.modelKey }, env: {}, guestProvider: client })).toThrow("session mismatch");
  expect(() => assertRuntimeExecutionPosture({ executionPosture: "confined-guest" })).toThrow("protected tool-side"); client.close();
});

test("response invocation/sequence/frame errors fail without local fallback, retry or raw error exposure", async () => {
  for (const fault of ["identity", "sequence", "frame", "transport"]) {
    let calls = 0, closed = 0; const client = createGuestProviderClient({ scope, selection, port: { exchange: async bytes => { calls++; const request = JSON.parse(Buffer.from(bytes).subarray(4).toString()); if (fault === "transport") throw new Error("HOST-SECRET-MUST-NOT-LEAK"); if (fault === "frame") return new Uint8Array([1, 2]); return frame({ version: 1, invocationId: fault === "identity" ? "other" : request.invocationId, sequence: fault === "sequence" ? 99 : request.sequence, kind: "accepted" }); }, close: () => { closed++; throw new Error("HOST-SECRET-CLOSE-ERROR"); } } });
    await expect(guestProviderFor(client, resolved).generate({ messages: [] })).rejects.toThrow("guest provider channel unavailable"); expect(calls).toBe(1); expect(closed).toBe(1);
  }
});

test("aborting one invocation fences its late response while another and later turns complete", async () => {
  let answer!: (value: Uint8Array) => void, late: any, closed=0, holdFirst=true; const abort=new AbortController(), seen:any[]=[];
  const client=createGuestProviderClient({scope,selection,port:{exchange:async bytes=>{
    const request=JSON.parse(Buffer.from(bytes).subarray(4).toString());seen.push(request);
    if(request.operation==="begin"&&holdFirst){holdFirst=false;late=request;return new Promise(resolve=>{answer=resolve;});}
    return frame({version:1,invocationId:request.invocationId,sequence:request.sequence,kind:request.operation==="begin"?"accepted":request.operation==="cancel"?"closed":"event",...(request.operation==="next"?{event:{type:"done",stopReason:"end_turn"}}:{})});
  },close(){closed++;}}});
  const provider=guestProviderFor(client,resolved);
  const held=provider.generate({messages:[{role:"user",content:"hold"}],signal:abort.signal});void held.catch(()=>{});
  await Bun.sleep(0);expect(late).toBeDefined();
  await expect(provider.generate({messages:[]})).resolves.toMatchObject({kind:"text"});
  abort.abort();await expect(held).rejects.toThrow();expect(closed).toBe(0);
  answer(frame({version:1,invocationId:late.invocationId,sequence:late.sequence,kind:"accepted"}));
  await expect(provider.generate({messages:[]})).resolves.toMatchObject({kind:"text"});
  expect(seen.filter(x=>x.operation==="cancel")).toHaveLength(1);expect(seen.filter(x=>x.operation==="begin").map(x=>x.invocationOrdinal)).toEqual([1,2,3]);expect(closed).toBe(0);client.close();
});
test("concurrent provider invocations retain independent events and sequences", async () => {
  const seen=new Map<string,number[]>();let closed=0;
  const client=createGuestProviderClient({scope,selection,port:{exchange:async bytes=>{
    const request=JSON.parse(Buffer.from(bytes).subarray(4).toString());const calls=seen.get(request.invocationId)??[];calls.push(request.sequence);seen.set(request.invocationId,calls);await Bun.sleep(1);
    return frame({version:1,invocationId:request.invocationId,sequence:request.sequence,kind:request.operation==="begin"?"accepted":"event",...(request.operation==="next"?{event:request.sequence===1?{type:"text_delta",text:request.invocationId}:{type:"done",stopReason:"end_turn"}}:{})});
  },close(){closed++;}}});
  const provider=guestProviderFor(client,resolved), results=await Promise.all([provider.generate({messages:[]}),provider.generate({messages:[]})]);
  expect(seen.size).toBe(2);expect([...seen.values()]).toEqual([[0,1,2],[0,1,2]]);expect(new Set(results.map(value=>value.kind==="text"?value.text:"")).size).toBe(2);expect(closed).toBe(0);client.close();
});
test("host invocation capacity refusal does not close the client", async () => {
  let refused=false,closed=0;
  const client=createGuestProviderClient({scope,selection,port:{exchange:async bytes=>{
    const r=JSON.parse(Buffer.from(bytes).subarray(4).toString());if(!refused){refused=true;return frame({version:1,invocationId:r.invocationId,sequence:r.sequence,kind:"refused",code:"capacity_busy"});}
    return frame({version:1,invocationId:r.invocationId,sequence:r.sequence,kind:r.operation==="begin"?"accepted":"event",...(r.operation==="next"?{event:{type:"done",stopReason:"end_turn"}}:{})});
  },close(){closed++;}}});
  await expect(guestProviderFor(client,resolved).generate({messages:[]})).rejects.toMatchObject({code:"rate_limit",retryable:true});expect(closed).toBe(0);
  await expect(guestProviderFor(client,resolved).generate({messages:[]})).resolves.toMatchObject({kind:"text"});client.close();
});

test("pending polls keep the same invocation and never resend the turn", async () => {
  const seen: any[] = []; const events = [{ type: "text_delta", text: "slow valid result" }, { type: "done", stopReason: "end_turn" }];
  const client = createGuestProviderClient({ scope, selection, port: { exchange: async bytes => {
    const request = JSON.parse(Buffer.from(bytes).subarray(4).toString()); seen.push(request);
    return frame({ version: 1, invocationId: request.invocationId, sequence: request.sequence, kind: request.operation === "begin" ? "accepted" : request.sequence <= 2 ? "pending" : "event", ...(request.sequence >= 3 ? { event: events[request.sequence - 3] } : {}) });
  }, close() {} } });
  const turn = await guestProviderFor(client, resolved).generate({ messages: [{ role: "user", content: "hello" }] }); expect(turn.kind).toBe("text"); if (turn.kind === "text") expect(turn.text).toBe("slow valid result"); expect(seen.map(value => value.operation)).toEqual(["begin", "next", "next", "next", "next"]); expect(new Set(seen.map(value => value.invocationId)).size).toBe(1); expect(seen.filter(value => value.turn !== undefined)).toHaveLength(1); client.close();
});

test("ignored transport cancellation is bounded by the exchange deadline and is never retried", async () => {
  let calls = 0, closed = 0;
  const client = createGuestProviderClient({ scope, selection, port: { exchange: async () => { calls++; return new Promise<Uint8Array>(() => {}); }, close: () => { closed++; } } });
  const before = performance.now(); await expect(guestProviderFor(client, resolved).generate({ messages: [] })).rejects.toThrow("guest provider channel unavailable"); expect(performance.now() - before).toBeGreaterThan(5900); expect(performance.now() - before).toBeLessThan(9000); expect(calls).toBe(1); expect(closed).toBe(1);
}, 12_000);

test("oversized and incorrectly delimited response bytes refuse before fold or local fallback", async () => {
  for (const malformed of [new Uint8Array(256 * 1024 + 4096 + 5), new Uint8Array([0, 0, 0, 2, 123])]) {
    let calls = 0;
    const client = createGuestProviderClient({ scope, selection, port: { exchange: async () => { calls++; return malformed; }, close() {} } });
    await expect(guestProviderFor(client, resolved).generate({ messages: [] })).rejects.toThrow("guest provider channel unavailable"); expect(calls).toBe(1);
  }
});


test("fresh engine route accepts only the provider folded from its exact private client", () => {
  const port = { exchange: async () => { throw new Error("never exchange"); }, close() {} };
  const first = createGuestProviderClient({ scope, selection, port }), second = createGuestProviderClient({ scope, selection, port });
  const route = guestProviderFor(first, resolved);
  expect(() => assertGuestProviderRoute(first, route)).not.toThrow();
  expect(() => assertGuestProviderRoute(second, route)).toThrow("route unavailable");
  expect(() => assertGuestProviderRoute(first, { generate: route.generate })).toThrow("route unavailable");
  first.close(); second.close();
});

test("an early consumer return cancels only its invocation and preserves the next turn",async()=>{
 let cancelled=0,closed=0;
 const client=createGuestProviderClient({scope,selection,port:{exchange:async bytes=>{
  const r=JSON.parse(Buffer.from(bytes).subarray(4).toString());if(r.operation==="cancel")cancelled++;
  return frame({version:1,invocationId:r.invocationId,sequence:r.sequence,kind:r.operation==="begin"?"accepted":r.operation==="cancel"?"closed":"event",...(r.operation==="next"?{event:r.sequence===1?{type:"text_delta",text:"answer"}:{type:"done",stopReason:"end_turn"}}:{})});
 },close(){closed++;}}});
 const provider=guestProviderFor(client,resolved);
 await expect(provider.generate({messages:[],sink:{onStreamEvent(){throw new Error("consumer stopped");},onRetry(){},onRateLimit(){},onAuthStatus(){},onReasoningSummary(){},onReasoningProgress(){}}})).rejects.toThrow();
 expect(cancelled).toBe(1);expect(closed).toBe(0);
 await expect(provider.generate({messages:[]})).resolves.toMatchObject({kind:"text",text:"answer"});client.close();
});
