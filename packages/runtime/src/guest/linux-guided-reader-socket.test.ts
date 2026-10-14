import { expect, test } from "bun:test";
import { createLinuxGuidedReaderSocketWire } from "./linux-guided-reader-socket.ts";
/** All effects are inert ownership observations. No Socket, FD or syscall runs. */
function fixture(mode: "success" | "throw" | "no-adopt" | "reuse" | "constructor-throw" = "success") {
  const handlers = new Map<string, ((...args: any[]) => void)[]>(), actions: string[] = [];
  let inode = 100;
  const emit = (event: string, ...args: unknown[]) => { for (const handler of handlers.get(event) ?? []) handler(...args); };
  const wire = createLinuxGuidedReaderSocketWire({
    claimDup() { actions.push("claim-once"); return 7; }, shutdownOriginal() { actions.push("shutdown-original"); },
    identity() { actions.push("identity"); return { dev: 1, ino: inode }; }, closeUnadopted(fd) { actions.push(`close-unadopted:${fd}`); },
    socket() {
      actions.push("construct-without-fd"); if (mode === "constructor-throw") throw new Error("constructor unavailable");
      return { on(event: string, handler: (...args: any[]) => void) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
        connect(options: { fd: number }) { expect(options).toEqual({ fd: 7 }); actions.push("connect-inherited-fd");
          if (mode === "reuse") { inode = 999; throw new Error("fd number reused"); }
          if (mode === "throw") throw new Error("not adopted"); if (mode === "success") emit("connect");
        }, write(_frame: Uint8Array, callback: (error?: Error | null) => void) { actions.push("write"); callback(null); },
        destroy() { actions.push("destroy-js-owner"); emit("close"); },
      };
    },
  });
  return { wire, actions, emit, reuse() { inode = 999; } };
}

test("one explicit inherited connect adopts dup; terminal closes original and JS owner without numeric reclose", async () => {
  const f = fixture(), losses: string[] = [];
  expect(f.actions).toEqual(["claim-once", "identity", "construct-without-fd"]);
  f.wire.subscribe(() => {}, () => losses.push("lost")); await f.wire.send(new Uint8Array([1]));
  f.reuse(); f.wire.close(); f.wire.close(); f.emit("end");
  expect(f.actions).toEqual(["claim-once", "identity", "construct-without-fd", "connect-inherited-fd", "write", "shutdown-original", "destroy-js-owner"]);
  expect(losses).toEqual(["lost"]); await expect(f.wire.send(new Uint8Array([1]))).rejects.toThrow("required_context_unavailable");
});

test("unadopted failure closes only the still-owned original dup identity", () => {
  for (const mode of ["throw", "no-adopt"] as const) {
    const f = fixture(mode); expect(() => f.wire.subscribe(() => {}, () => {})).toThrow("required_context_unavailable");
    expect(f.actions.filter(action => action === "shutdown-original")).toHaveLength(1);
    expect(f.actions.filter(action => action === "close-unadopted:7")).toHaveLength(1);
    f.wire.close(); f.emit("connect"); expect(f.actions.filter(action => action === "close-unadopted:7")).toHaveLength(1);
  }
  const reused = fixture("reuse"); expect(() => reused.wire.subscribe(() => {}, () => {})).toThrow("required_context_unavailable");
  expect(reused.actions).not.toContain("close-unadopted:7");
  expect(() => fixture("constructor-throw")).toThrow("required_context_unavailable");
});

test("normal frame responses leave persistent stream open; any half-close is terminal", async () => {
  const f = fixture(), received: number[] = []; let lost = 0;
  f.wire.subscribe(chunk => received.push(chunk[0]!), () => { lost++; });
  await f.wire.send(new Uint8Array([1])); f.emit("data", new Uint8Array([2]));
  await f.wire.send(new Uint8Array([3])); f.emit("data", new Uint8Array([4]));
  expect(received).toEqual([2, 4]); expect(f.actions).not.toContain("shutdown-original");
  f.emit("end"); expect(lost).toBe(1); expect(f.actions).toContain("shutdown-original"); expect(f.actions).toContain("destroy-js-owner");
  f.emit("data", new Uint8Array([5])); expect(received).toEqual([2, 4]);
});

test("loss close orders are idempotent and detached subscription never reopens", () => {
  for (const first of ["error", "end", "close", "explicit"]) {
    const f = fixture(); const detach = f.wire.subscribe(() => {}, () => {});
    if (first === "explicit") f.wire.close(); else f.emit(first);
    for (const event of ["close", "end", "error"]) f.emit(event); f.wire.close(); detach();
    expect(f.actions.filter(action => action === "claim-once")).toHaveLength(1);
    expect(f.actions.filter(action => action === "shutdown-original")).toHaveLength(1);
    expect(f.actions.filter(action => action === "destroy-js-owner")).toHaveLength(1);
    expect(() => f.wire.subscribe(() => {}, () => {})).toThrow();
  }
});
