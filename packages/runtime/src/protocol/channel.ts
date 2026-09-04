import type { WinterFrame } from "@yanlinglabs/winter-agent-sdk";
export interface FrameSink { write(f: WinterFrame): void; end(): void; }
export type FrameSource = AsyncIterable<WinterFrame>;
export interface Duplex { input: FrameSource; output: FrameSink; }

// Generic so the byte-level transport (winter-agent-runtime/testing's inMemoryProcess, Task 2) can
// reuse the identical backpressure-safe queue semantics for raw string chunks — one queue
// implementation, two instantiations (WinterFrame here, string over there), never two hand-rolled
// copies (WS-04 §1: one framing code path for both transports).
export class Queue<T> implements AsyncIterable<T> {
  private buf: T[] = []; private resolvers: Array<(r: IteratorResult<T>) => void> = []; private ended = false;
  write(v: T) { const r = this.resolvers.shift(); if (r) r({ value: v, done: false }); else this.buf.push(v); }
  end() { this.ended = true; for (const r of this.resolvers.splice(0)) r({ value: undefined as never, done: true }); }
  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.buf.length) { yield this.buf.shift()!; continue; }
      if (this.ended) return;
      const res = await new Promise<IteratorResult<T>>((resolve) => this.resolvers.push(resolve));
      if (res.done) return; yield res.value;
    }
  }
}

// DRIVING A RAW `runEngine` OVER THIS CHANNEL (P4 fix wave, KNOWN item 6 -- a note, not a change):
// a test that wires `runEngine({input: runtime.input, output: runtime.output})` to this pair MUST
// write BOTH an initial `{type:"user"}` envelope AND a `{type:"control_request", subtype:"end_input"}`
// on `host.output`. Without the user frame the engine's turn loop never starts; without `end_input`
// the pump's `userFrames` queue is never ended, so the loop never exits, `runEngine`'s promise never
// resolves, and a `for await` over `host.input` never completes -- the test HANGS with no error and
// no output, which reads like a deadlock in the code under test rather than a missing frame. Every
// harness in this repo that drives a raw engine (subagents/child-engine.test.ts's `driveParent`,
// store/resume.test.ts's `runOneEnvelope`, engine.test.ts's own drivers) writes both, in that order;
// copy one of them rather than hand-rolling a third.
export function createInMemoryChannel(): { host: Duplex; runtime: Duplex } {
  const hostToRuntime = new Queue<WinterFrame>(); const runtimeToHost = new Queue<WinterFrame>();
  return {
    host: { input: runtimeToHost, output: hostToRuntime },
    runtime: { input: hostToRuntime, output: runtimeToHost },
  };
}
