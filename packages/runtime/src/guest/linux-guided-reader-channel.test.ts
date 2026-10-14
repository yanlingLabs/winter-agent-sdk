import { expect, test } from "bun:test";
import { createLinuxGuidedReaderChannel, type LinuxGuidedReaderWire } from "./linux-guided-reader-channel.ts";
import { LINUX_GUIDED_READER_LIMITS, type LinuxGuidedReaderRegistration } from "./linux-guided-reader-protocol.ts";
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const registration: LinuxGuidedReaderRegistration = { version: 1, registrationId: uuid(1), owner: { workspaceId: "workspace", logicalSessionId: "logical", backendSessionId: "backend",
  incarnationId: "incarnation", leaseEpoch: 1, bootId: uuid(2), generation: 1 }, views: { sourceRoot: "/workspace/folders/source", sourceCwd: "/workspace/folders/source",
  sharedRoot: "/run/winter/shared-instructions", sharedPath: "/run/winter/shared-instructions/WINTER.md" }, limits: LINUX_GUIDED_READER_LIMITS, requiredRuntimeContext: { version: 1, bindingId: uuid(3) } };
const request = (n = 10) => ({ version: 1 as const, bindingId: uuid(3), contextRequestId: uuid(n + 100), readId: uuid(n) });
function encoded(value: unknown) { const body = Buffer.from(JSON.stringify(value)), wire = Buffer.alloc(body.length + 4); wire.writeUInt32BE(body.length); body.copy(wire, 4); return wire; }
function result(n = 10) {
  const { workspaceId: _workspaceId, ...owner } = registration.owner;
  const frame = JSON.stringify({ version: 1, readId: uuid(n), owner, views: registration.views, limits: registration.limits,
    snapshot: { blocks: [], digest: "fixture", droppedImports: [], files: [], provenance: [], skippedLinks: [], text: "guidance", tiers: "admitted-only" } }) + "\n";
  return { version: 1, kind: "reader_result", registrationId: uuid(1), readId: uuid(n), owner: registration.owner, frame };
}
function terminal(n = 10, outcome = "ok") { return { version: 1, kind: "reader_terminal", registrationId: uuid(1), readId: uuid(n), owner: registration.owner, outcome,
  namespaceInitReaped: true, monitorReaped: true, namespaceWaitStatus: 0, monitorWaitStatus: 0, stdoutEof: true, stderrEof: true, captureDrained: true }; }
async function tick() { for (let n = 0; n < 12; n++) await Promise.resolve(); }
function fixture() {
  let data!: (chunk: Uint8Array) => void, lost!: () => void, ownerHeld = true, closes = 0, unsubscribes = 0, remainingChecks: number | undefined;
  const sent: unknown[] = [];
  const wire: LinuxGuidedReaderWire = { async send(bytes) { sent.push(JSON.parse(Buffer.from(bytes).subarray(4).toString())); },
    subscribe(onData, onLost) { data = onData; lost = onLost; return () => { unsubscribes++; }; }, close() { closes++; } };
  const channel = createLinuxGuidedReaderChannel({ registration, wire, assertOwnerHeld() {
    if (!ownerHeld || (remainingChecks !== undefined && remainingChecks-- <= 0)) throw new Error("private owner failure");
  } });
  return { channel, sent, data: (bytes: Uint8Array) => data(bytes), emit: (value: unknown) => data(encoded(value)), lose: () => lost(),
    loseOwner() { ownerHeld = false; }, failOwnerAfter(checks: number) { remainingChecks = checks; }, get closes() { return closes; }, get unsubscribes() { return unsubscribes; } };
}

test("operation exists before send; fragmented result does not discharge debt before distinct terminal", async () => {
  const f = fixture(), operation = f.channel.start(request(), { signal: new AbortController().signal }); let drained = false;
  void operation.drained.then(() => { drained = true; });
  expect(f.sent).toEqual([]); expect(f.channel.diagnostics().outstanding).toBe(1); await tick(); expect(f.sent).toHaveLength(1);
  const bytes = encoded(result()); for (let at = 0; at < bytes.length; at += 3) f.data(bytes.subarray(at, at + 3));
  expect(await operation.result).toEqual({ ...request(), frame: result().frame }); await tick(); expect(drained).toBe(false);
  f.emit(terminal()); await operation.drained; expect(f.channel.diagnostics().outstanding).toBe(0);
  expect(() => f.channel.start(request(), { signal: new AbortController().signal })).toThrow("required_context_unavailable");
  f.channel.close();
});

test("multiplexed reads retain independent result/terminal correlation; repeated terminal is fatal", async () => {
  const f = fixture(), one = f.channel.start(request(10), { signal: new AbortController().signal }), two = f.channel.start(request(11), { signal: new AbortController().signal });
  f.data(Buffer.concat([encoded(result(11)), encoded(terminal(11)), encoded(result(10))]));
  await two.result; await two.drained; expect(f.channel.diagnostics().outstanding).toBe(1);
  f.emit(terminal(11)); expect(f.channel.diagnostics().closed).toBe(true); expect(f.closes).toBe(1); expect(f.unsubscribes).toBe(1);
  await expect(one.drained).rejects.toThrow("required_context_unavailable"); expect(f.channel.diagnostics().outstanding).toBe(1);
});

test("cancel sends once and rejects result; a late valid result cannot replace refusal and cleanup still requires terminal", async () => {
  const f = fixture(), abort = new AbortController(), operation = f.channel.start(request(), { signal: abort.signal });
  await tick(); abort.abort(); operation.cancel(); await tick(); expect(f.sent).toHaveLength(2);
  expect((f.sent[1] as { kind: string }).kind).toBe("reader_cancel"); await expect(operation.result).rejects.toThrow("required_context_unavailable");
  f.emit(result()); expect(f.channel.diagnostics().outstanding).toBe(1);
  f.emit(terminal(10, "cancelled")); await operation.drained; expect(f.channel.diagnostics().outstanding).toBe(0); f.channel.close();
});

test("closed/foreign/unknown/malformed channel evidence retains debt and never manufactures drain", async () => {
  for (const evidence of [terminal(99), { ...terminal(), owner: { ...registration.owner, generation: 2 } },
    { ...terminal(), captureDrained: false }, terminal(), { ...result(), frame: "{}\n" }]) {
    const f = fixture(), operation = f.channel.start(request(), { signal: new AbortController().signal });
    f.emit(evidence); await expect(operation.drained).rejects.toThrow("required_context_unavailable");
    expect(f.channel.diagnostics()).toEqual({ closed: true, outstanding: 1, consumed: 1 });
  }
  for (const loss of ["wire", "owner"]) {
    const f = fixture(), operation = f.channel.start(request(), { signal: new AbortController().signal });
    if (loss === "wire") f.lose(); else { f.loseOwner(); f.emit(result()); }
    await expect(operation.result).rejects.toThrow("required_context_unavailable"); await expect(operation.drained).rejects.toThrow("required_context_unavailable");
    expect(f.channel.diagnostics().outstanding).toBe(1); f.emit(terminal()); expect(f.closes).toBe(1);
  }
});

test("capacity, replay and pre-abort refuse before another request is sent", async () => {
  const f = fixture(), abort = new AbortController(); abort.abort();
  expect(() => f.channel.start(request(), { signal: abort.signal })).toThrow(); expect(f.channel.diagnostics().outstanding).toBe(0);
  for (let n = 0; n < 16; n++) f.channel.start(request(n + 10), { signal: new AbortController().signal });
  expect(() => f.channel.start(request(26), { signal: new AbortController().signal })).toThrow();
  await tick(); expect(f.sent).toHaveLength(16); f.channel.close();
});

test("owner loss on the final terminal check rejects drain and retains registered debt", async () => {
  const f = fixture(), operation = f.channel.start(request(), { signal: new AbortController().signal });
  f.emit(result()); await operation.result;
  // data(), accept(), post-decode held(), then the final pre-settlement check.
  f.failOwnerAfter(3); f.emit(terminal());
  await expect(operation.drained).rejects.toThrow("required_context_unavailable");
  expect(f.channel.diagnostics()).toEqual({ closed: true, outstanding: 1, consumed: 1 });
}, 1000);

test("frame bounds permit a coalesced callback larger than one frame without retaining the whole chunk", async () => {
  const f = fixture(), operations = [];
  const frames = [];
  for (let n = 10; n < 26; n++) {
    operations.push(f.channel.start(request(n), { signal: new AbortController().signal }));
    const response = result(n), inner = JSON.parse(response.frame);
    inner.snapshot.text = "current guidance ".repeat(6500);
    response.frame = JSON.stringify(inner) + "\n";
    frames.push(encoded(response), encoded(terminal(n)));
  }
  const coalesced = Buffer.concat(frames); expect(coalesced.length).toBeGreaterThan(1024 * 1024 + 4096);
  f.data(coalesced);
  await Promise.all(operations.map(operation => operation.drained));
  expect(f.channel.diagnostics()).toEqual({ closed: false, outstanding: 0, consumed: 16 }); f.channel.close();
});
