import { closeSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostOutputTransport } from "../host-output.ts";

// FIXTURE ONLY. The temporary C source is not an immutable/protected production graph.
// Production callers must inject a packaged native host adapter; never import this fixture there.
const SOURCE = `
extern int pipe(int *);
extern int fcntl(int, int, ...);
extern int close(int);
extern long read(int, void *, unsigned long);
extern int *__error(void);
struct pollfd { int fd; short events; short revents; };
extern int poll(struct pollfd *, unsigned int, int);
int winter_pipe(int *fds) {
  if (pipe(fds)) return -1;
  for(int i=0;i<2;i++) {
    if(fcntl(fds[i],2,1)<0 || !(fcntl(fds[i],1,0)&1)) goto fail;
  }
  int flags=fcntl(fds[0],3,0);
  if(flags<0 || fcntl(fds[0],4,flags|4)<0 || !(fcntl(fds[0],3,0)&4)) goto fail;
  return 0;
fail: close(fds[0]); close(fds[1]); return -1;
}
long winter_read(int fd,void *buffer,unsigned long count) {
  long n=read(fd,buffer,count); return n<0 ? -(long)*__error() : n;
}
int winter_poll(struct pollfd *fds,unsigned int count) { return poll(fds,count,0); }
`;
async function loadHostLibc() {
  const { cc } = await import("bun:ffi");
  const dir=mkdtempSync(join(tmpdir(),"winter-host-output-fixture-"));
  try {
    const source=join(dir,"fixture.c");writeFileSync(source,SOURCE,{mode:0o400});
    return cc({ source, symbols: {
      winter_pipe: { args: ["ptr"], returns: "i32" },
      winter_read: { args: ["i32", "ptr", "u64"], returns: "i64" },
      winter_poll: { args: ["ptr", "u32"], returns: "i32" },
    } });
  } finally {rmSync(dir,{recursive:true,force:true});}
}

let native: ReturnType<typeof loadHostLibc> | undefined;
const readiness = new Map<number, Set<() => void>>();
let readinessTimer: ReturnType<typeof setTimeout> | undefined;

/** Initial host readiness adapter: one 10ms poll(0) timer shared by all waiting descriptors.
 * Descriptors are nonblocking; no file-I/O worker waits on a child and no per-stream timer runs. */
async function scheduleReadiness() {
  if (readinessTimer || !readiness.size) return;
  const libc = await native!;
  const { ptr } = await import("bun:ffi");
  if (readinessTimer || !readiness.size) return;
  readinessTimer = setTimeout(() => {
    readinessTimer = undefined;
    const fds = [...readiness.keys()];
    const array = new Int32Array(fds.length * 2);
    const shorts = new Uint16Array(array.buffer);
    fds.forEach((fd, index) => { array[index * 2] = fd; shorts[index * 4 + 2] = 1; }); // pollfd: fd, POLLIN, revents
    const ready = libc.symbols.winter_poll(ptr(array), fds.length);
    if (ready > 0) fds.forEach((fd, index) => { if (shorts[index * 4 + 3]) wake(fd); });
    void scheduleReadiness();
  }, 10);
}
function wake(fd: number) {
  const waiters = readiness.get(fd); readiness.delete(fd);
  if (waiters) for (const resolve of waiters) resolve();
  if (!readiness.size && readinessTimer) { clearTimeout(readinessTimer); readinessTimer = undefined; }
}
function waitReadable(fd: number) {
  return new Promise<void>(resolve => {
    const waiters = readiness.get(fd) ?? new Set<() => void>();
    waiters.add(resolve); readiness.set(fd, waiters); void scheduleReadiness();
  });
}

/** Own the POSIX read side: Bun's child_process/ReadableStream pipes eagerly drain even while
 * paused. Numeric child write fds avoid that buffer; each stream has one bounded read in flight. */
export async function createFixtureHostOutput(): Promise<HostOutputTransport> {
  if (process.platform !== "darwin" || typeof Bun === "undefined") throw new Error("bounded host output transport unavailable");
  const { ptr } = await import("bun:ffi");
  const libc = await (native ??= loadHostLibc());
  const descriptors: number[] = [];
  function pipe() {
    const fds = new Int32Array(2);
    if (libc.symbols.winter_pipe(ptr(fds)) !== 0) throw new Error("fixture host output nonblocking/CLOEXEC pipe unavailable");
    descriptors.push(...fds);
    return { read: fds[0]!, write: fds[1]! };
  }
  let stdout: ReturnType<typeof pipe>, stderr: ReturnType<typeof pipe>;
  try { stdout = pipe(); stderr = pipe(); }
  catch (error) { for (const fd of descriptors) try { closeSync(fd); } catch {} throw error; }
  const open = new Set(descriptors);
  function close(fd: number) { if (open.delete(fd)) { wake(fd); try { closeSync(fd); } catch {} } }
  let paused = false;
  let disposed = false;
  const waiters = new Set<() => void>();
  function resume() { paused = false; for (const wake of waiters) wake(); waiters.clear(); }
  async function pump(fd: number, consume: (chunk: Buffer) => void) {
    try {
      while (!disposed) {
        if (paused) await new Promise<void>(resolve => waiters.add(resolve));
        if (disposed) break;
        const buffer = Buffer.allocUnsafe(65536);
        const bytes = Number(libc.symbols.winter_read(fd, ptr(buffer), buffer.length));
        if (bytes === -35 || bytes === -4) { if (!disposed) await waitReadable(fd); continue; } // Darwin EAGAIN/EINTR
        if (bytes < 0) throw new Error(`fixture pipe read failed (${bytes})`);
        if (bytes === 0 || disposed) break;
        consume(buffer.subarray(0, bytes));
      }
    } finally { close(fd); }
  }
  return {
    stdoutFd: stdout.write,
    stderrFd: stderr.write,
    closeWriters() { close(stdout.write); close(stderr.write); },
    pause() { paused = true; }, resume,
    start(onStdout: (chunk: Buffer) => void, onStderr: (chunk: Buffer) => void) {
      return Promise.all([pump(stdout.read, onStdout), pump(stderr.read, onStderr)]);
    },
    dispose() { disposed = true; resume(); for (const fd of open) close(fd); },
  };
}
