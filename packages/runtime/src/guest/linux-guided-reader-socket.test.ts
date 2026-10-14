import { expect, test } from "bun:test";
import { createLinuxGuidedReaderSocketWire } from "./linux-guided-reader-socket.ts";
type Effects = NonNullable<Parameters<typeof createLinuxGuidedReaderSocketWire>[0]["connect"]>;
type Handlers = Parameters<Effects>[0]["socket"];
/** Every transfer/socket/write/close effect is injected. No Bun.connect/FD/syscall runs. */
function fixture(options: { transfer?: "open" | "connect-error" | "throw" | "reject" | "deferred";
  write?: (bytes: Uint8Array, handlers: Handlers, socket: Parameters<Handlers["open"]>[0]) => number } = {}) {
  const actions: string[] = [], attempts: number[][] = [];
  let handlers!: Handlers;
  const socket = { write(bytes: Uint8Array) { attempts.push([...bytes]); actions.push("write"); return options.write?.(bytes, handlers, socket) ?? bytes.length; },
    terminate() { actions.push("terminate-adopted"); handlers.close(socket); } };
  const wire = createLinuxGuidedReaderSocketWire({
    claimDup() { actions.push("claim-once"); return 7; }, shutdownOriginal() { actions.push("shutdown-original"); },
    validateDup() { actions.push("validate-fresh"); }, closeUnadopted(fd) { actions.push(`close-raw:${fd}`); },
    connect(value) {
      expect(Object.keys(value).sort()).toEqual(["fd", "socket"]); expect(value.fd).toBe(7); actions.push("transfer-attempt"); handlers = value.socket;
      if (options.transfer === "throw") throw new Error("uncertain transfer");
      if (options.transfer === "reject") return Promise.reject(new Error("uncertain transfer"));
      if (options.transfer === "deferred") return new Promise(() => {});
      if (options.transfer === "connect-error") { handlers.connectError(socket, new Error("detached fromFd failure")); return Promise.reject(new Error("connect rejected")); }
      handlers.open(socket); return Promise.resolve(socket);
    },
  });
  let losses = 0;
  return { wire, actions, attempts, socket, subscribe() { return wire.subscribe(() => {}, () => { losses++; }); },
    handlers: () => handlers, losses: () => losses };
}
async function tick() { for (let n = 0; n < 12; n++) await Promise.resolve(); }

test("successful transfer records adopted socket and never closes its saved descriptor number", async () => {
  const f = fixture(); expect(f.actions).toEqual(["claim-once", "validate-fresh"]);
  f.subscribe(); await f.wire.send(new Uint8Array([1])); f.wire.close(); f.wire.close(); f.handlers().close(f.socket);
  expect(f.actions).toEqual(["claim-once", "validate-fresh", "transfer-attempt", "write", "shutdown-original", "terminate-adopted"]);
  expect(f.losses()).toBe(1); await expect(f.wire.send(new Uint8Array([1]))).rejects.toThrow("required_context_unavailable");
});

test("first fresh-descriptor observation failure closes caller-owned raw dup before any transfer", () => {
  const actions: string[] = [];
  expect(() => createLinuxGuidedReaderSocketWire({ claimDup() { actions.push("claim"); return 7; },
    validateDup() { actions.push("first-observation"); throw new Error("fstat failed"); },
    closeUnadopted(fd) { actions.push(`close-raw:${fd}`); }, shutdownOriginal() { actions.push("shutdown-original"); },
    connect() { actions.push("must-not-transfer"); throw new Error("must not transfer"); },
  })).toThrow("required_context_unavailable");
  expect(actions).toEqual(["claim", "first-observation", "shutdown-original", "close-raw:7"]);
});

test("explicit detached connectError alone returns raw ownership once, including after generic loss", async () => {
  const failed = fixture({ transfer: "connect-error" }); expect(() => failed.subscribe()).toThrow("required_context_unavailable");
  await tick(); failed.handlers().connectError(failed.socket, new Error("duplicate")); failed.wire.close();
  expect(failed.actions.filter(action => action === "close-raw:7")).toHaveLength(1);
  expect(failed.actions).not.toContain("terminate-adopted");
  for (const transfer of ["throw", "reject", "deferred"] as const) {
    const f = fixture({ transfer }); expect(() => f.subscribe()).toThrow("required_context_unavailable"); await tick();
    expect(f.actions).not.toContain("close-raw:7");
    f.handlers().connectError(f.socket, new Error("explicit late detached failure"));
    f.handlers().connectError(f.socket, new Error("duplicate"));
    expect(f.actions.filter(action => action === "close-raw:7")).toHaveLength(1);
  }
});

test("late open records adoption first and terminates, never raw-closing a now-adopted/reused number", () => {
  const f = fixture({ transfer: "deferred" }); expect(() => f.subscribe()).toThrow();
  f.handlers().open(f.socket); f.handlers().connectError(f.socket, new Error("late detached claim is false"));
  expect(f.actions).toContain("terminate-adopted"); expect(f.actions).not.toContain("close-raw:7");
});

test("short/zero writes retain copied suffixes, await drain and preserve FIFO", async () => {
  let remaining = 2;
  const f = fixture({ write(bytes) { const count = Math.min(remaining, bytes.length); remaining = 0; return count; } }); f.subscribe();
  const original = new Uint8Array([1, 2, 3, 4]), one = f.wire.send(original), two = f.wire.send(new Uint8Array([5, 6]));
  original.fill(9); await tick(); expect(f.attempts).toEqual([[1, 2, 3, 4]]);
  remaining = 2; f.handlers().drain(f.socket); await one;
  expect(f.attempts.at(-1)).toEqual([5, 6]); remaining = 2; f.handlers().drain(f.socket); await two;
  expect(f.attempts).toEqual([[1, 2, 3, 4], [3, 4], [5, 6], [5, 6]]); f.wire.close();
});

test("active partial write counts against capacity; full 4100-byte frames fit and close rejects every queued write", async () => {
  const f = fixture({ write: () => 0 }); f.subscribe(); const writes = [];
  for (let n = 0; n < 16; n++) { const write = f.wire.send(new Uint8Array(4100)); void write.catch(() => {}); writes.push(write); }
  await expect(f.wire.send(new Uint8Array([1]))).rejects.toThrow("required_context_unavailable");
  await expect(f.wire.send(new Uint8Array(4101))).rejects.toThrow("required_context_unavailable");
  f.wire.close(); for (const write of writes) await expect(write).rejects.toThrow("required_context_unavailable");
});

test("invalid write counts/throws and reentrant close fail terminally without numeric dup close", async () => {
  for (const count of [-1, NaN, 0.5, 2]) {
    const f = fixture({ write: () => count }); f.subscribe(); await expect(f.wire.send(new Uint8Array([1]))).rejects.toThrow();
    expect(f.actions).not.toContain("close-raw:7"); expect(f.actions).toContain("terminate-adopted");
  }
  const throwing = fixture({ write() { throw new Error("private write failure"); } }); throwing.subscribe();
  await expect(throwing.wire.send(new Uint8Array([1]))).rejects.toThrow("required_context_unavailable");
  const reentrant = fixture({ write(_bytes, handlers, socket) { handlers.drain(socket); handlers.close(socket); return 0; } }); reentrant.subscribe();
  await expect(reentrant.wire.send(new Uint8Array([1]))).rejects.toThrow(); expect(reentrant.attempts).toHaveLength(1);
});

test("normal data leaves persistent channel open, every loss close order is idempotent", async () => {
  for (const event of ["error", "close", "end", "explicit"]) {
    const f = fixture(), received: number[] = [];
    f.wire.subscribe(bytes => received.push(bytes[0]!), () => {});
    await f.wire.send(new Uint8Array([1])); f.handlers().data(f.socket, new Uint8Array([2]));
    await f.wire.send(new Uint8Array([3])); f.handlers().data(f.socket, new Uint8Array([4]));
    expect(received).toEqual([2, 4]); expect(f.actions).not.toContain("shutdown-original");
    if (event === "error") f.handlers().error(f.socket, new Error("lost")); else if (event === "close") f.handlers().close(f.socket); else if (event === "end") f.handlers().end(f.socket); else f.wire.close();
    f.wire.close(); f.handlers().close(f.socket); f.handlers().data(f.socket, new Uint8Array([5]));
    expect(received).toEqual([2, 4]); expect(f.actions.filter(action => action === "shutdown-original")).toHaveLength(1);
    expect(f.actions.filter(action => action === "terminate-adopted")).toHaveLength(1); expect(() => f.subscribe()).toThrow();
  }
});
