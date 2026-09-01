import type { WinterFrame } from "./frames.ts";
export interface FrameSink { write(f: WinterFrame): void; end(): void; }
export type FrameSource = AsyncIterable<WinterFrame>;
export interface Duplex { input: FrameSource; output: FrameSink; }

class Queue implements FrameSink, AsyncIterable<WinterFrame> {
  private buf: WinterFrame[] = []; private resolvers: Array<(r: IteratorResult<WinterFrame>) => void> = []; private ended = false;
  write(f: WinterFrame) { const r = this.resolvers.shift(); if (r) r({ value: f, done: false }); else this.buf.push(f); }
  end() { this.ended = true; for (const r of this.resolvers.splice(0)) r({ value: undefined as never, done: true }); }
  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.buf.length) { yield this.buf.shift()!; continue; }
      if (this.ended) return;
      const res = await new Promise<IteratorResult<WinterFrame>>((resolve) => this.resolvers.push(resolve));
      if (res.done) return; yield res.value;
    }
  }
}

export function createInMemoryChannel(): { host: Duplex; runtime: Duplex } {
  const hostToRuntime = new Queue(); const runtimeToHost = new Queue();
  return {
    host: { input: runtimeToHost, output: hostToRuntime },
    runtime: { input: hostToRuntime, output: runtimeToHost },
  };
}
