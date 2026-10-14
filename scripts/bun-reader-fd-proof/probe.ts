/** Standalone target-only fixture. Importing this file is NOT a source test.
 * Private cast exercises only the pinned preconnected non-TLS fd branch. */
export {};
const VERSION = "1.3.14", REVISION = "0d9b296af33f2b851fcbf4df3e9ec89751734ba4";
if (process.argv[2] !== "--admitted-fixture" || process.platform !== "linux" ||
    process.getuid?.() === 0 || Bun.version !== VERSION || Bun.revision !== REVISION) {
  console.log(JSON.stringify({ status: "SKIP", reason: "exact admitted unprivileged Linux target required" }));
  process.exit(77);
}
// No native/FD imports before the explicit gate above.
const { dlopen, FFIType, read } = await import("bun:ffi");
const { openSync, closeSync, fstatSync } = await import("node:fs");
const native = dlopen("libc.so.6", {
  fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  __errno_location: { args: [], returns: FFIType.ptr },
});
const fdObservations: { fd: number; flags: number; errno: number; label: string }[] = [];
const fdState = (fd: number, label = "preflight") => {
  const flags = native.symbols.fcntl(fd, 1 /* F_GETFD */, 0);
  const errno = flags < 0 ? read.i32(native.symbols.__errno_location()!) : 0;
  fdObservations.push({ fd, flags, errno, label });
  if (flags < 0 && errno !== 9 /* EBADF */) throw new Error("unexpected_f_getfd_error");
  return flags >= 0;
};
const dupAt = (fd: number, minimum: number) => native.symbols.fcntl(fd, 1030 /* F_DUPFD_CLOEXEC */, minimum);
const [adoptFd, originalFd, invalidFd, baselineFd] = process.argv.slice(3, 7).map(Number);
const reusePath = process.argv[7]!;
const must = (value: unknown, label: string) => { if (!value) throw new Error(label); };
for (const fd of [adoptFd, originalFd, invalidFd, baselineFd]) must(Number.isInteger(fd) && fd! >= 3 && fdState(fd!), "inherited_fd");
must(new Set([adoptFd, originalFd, invalidFd, baselineFd]).size === 4, "distinct_fds");
must(fstatSync(adoptFd!).isSocket() && fstatSync(originalFd!).isSocket(), "stream_fixture");
must(fstatSync(invalidFd!).isFile() && fstatSync(baselineFd!).isFile(), "regular_fixture");

interface Socket { write(bytes: Uint8Array): number; terminate(): void; }
interface Handlers {
  open(socket: Socket): void; data(socket: Socket, bytes: Uint8Array): void;
  drain(socket: Socket): void; close(socket: Socket): void; end(socket: Socket): void;
  error(socket: Socket, error: Error): void; connectError(socket: Socket, error: Error): void;
}
const connect = Bun.connect as unknown as (options: { fd: number; socket: Handlers }) => Promise<Socket>;
const report = (value: unknown) => console.log(JSON.stringify(value));
const output: Record<string, unknown> = { version: Bun.version, revision: Bun.revision, fdObservations };
const payload = Uint8Array.from({ length: 1024 * 1024 }, (_, i) => i % 251);
const received: number[] = [];
let socket: Socket | undefined, returned = false, openBeforeReturn = false, opens = 0;
let offset = 0, drains = 0, partials = 0, flushActive = false, terminated = false;
let resolveWritten!: () => void, rejectWritten!: (error: Error) => void;
const written = new Promise<void>((resolve, reject) => { resolveWritten = resolve; rejectWritten = reject; });
// Observe rejection immediately, including failures during a synchronous callback.
void written.catch(() => {});
const flush = () => {
  if (!socket || flushActive || terminated) return;
  flushActive = true;
  try {
    while (offset < payload.length) {
      const remaining = payload.length - offset;
      const count = socket.write(payload.subarray(offset));
      must(Number.isSafeInteger(count) && count >= 0 && count <= remaining, "write_count");
      offset += count;
      if (count < remaining) {
        partials++;
        report({ event: "backpressure", accepted: offset });
        return; // Never retry a short/zero write until real drain.
      }
    }
    resolveWritten();
  } catch (error) { rejectWritten(error as Error); }
  finally { flushActive = false; }
};
const timeout = setTimeout(() => { report({ status: "FAIL", stage: "deadline" }); process.exit(1); }, 12000);
try {
  const before = fdState(adoptFd!, "adopt_before");
  const pending = connect({ fd: adoptFd!, socket: {
    open(value) { socket = value; opens++; openBeforeReturn = !returned; },
    data(_value, bytes) { received.push(...bytes); },
    drain() { drains++; flush(); },
    close() { if (!terminated) rejectWritten(new Error("unexpected_close")); },
    end() { rejectWritten(new Error("unexpected_half_close")); },
    error() { rejectWritten(new Error("post_open_error")); },
    connectError() { rejectWritten(new Error("valid_connect_error")); },
  } });
  returned = true;
  void pending.catch(() => {});
  must(socket && opens === 1 && openBeforeReturn && fdState(adoptFd!), "synchronous_open");
  flush(); // First write precedes any event-loop writable notification.
  must((await pending) === socket, "promise_socket_identity");
  await written;
  while (received.length < 12) await Bun.sleep(1);
  must(new TextDecoder().decode(Uint8Array.from(received)) === "fixture-data", "actual_data");
  must(partials > 0 && drains > 0 && offset === payload.length, "actual_partial_drain");
  output.success = { before, openBeforeReturn, opens, partials, drains, accepted: offset,
    data: "fixture-data", beforeTerminate: fdState(adoptFd!, "adopt_before_terminate") };
  terminated = true;
  socket!.terminate();
  const afterTerminate = fdState(adoptFd!, "adopt_after_terminate");
  must(!afterTerminate && fdState(originalFd!) && fdState(baselineFd!), "synchronous_terminate");
  // Fresh fixture open, then allocate its duplicate at the now-free exact number.
  // No dup2/preclose of a descriptor with uncertain ownership is used.
  const fresh = openSync(reusePath, "r");
  const reused = fresh === adoptFd ? fresh : dupAt(fresh, adoptFd!);
  must(reused === adoptFd, "terminate_fd_reuse");
  socket!.terminate();
  await Bun.sleep(20); // Includes later native poll/socket freeing, not just callback return.
  const afterRepeatedTerminate = fdState(reused, "adopt_reuse_after_repeat");
  must(afterRepeatedTerminate && fstatSync(reused).isFile(), "terminate_no_stale_close");
  output.terminate = { afterTerminate, reusedExactNumber: reused === adoptFd,
    afterRepeatedTerminate, originalStillOpen: fdState(originalFd!) };
  closeSync(reused);
  if (fresh !== reused) closeSync(fresh);

  let failureReturned = false, failureOpen = false, errorCalls = 0;
  let callbackBeforeReturn = false, rawOpenInCallback = false, postOpenError = false;
  let callbackCode = "unclassified";
  let throwClass = "none", rejectionClass = "none", detachedSocket: Socket | undefined;
  const invalidBefore = fdState(invalidFd!, "invalid_before");
  try {
    const failure = connect({ fd: invalidFd!, socket: {
      open() { failureOpen = true; }, data() {}, drain() {}, close() {}, end() {},
      error() { postOpenError = true; },
      connectError(value, error) {
        detachedSocket = value; errorCalls++;
        callbackBeforeReturn = !failureReturned;
        rawOpenInCallback = fdState(invalidFd!, "invalid_in_connect_error");
        const code = (error as Error & { code?: unknown }).code;
        if (typeof code === "string" && /^[A-Z0-9_]{1,48}$/.test(code)) callbackCode = code;
      },
    } });
    failureReturned = true;
    try { await failure; rejectionClass = "resolved"; }
    catch { rejectionClass = "rejected"; }
  } catch { failureReturned = true; throwClass = "synchronous_throw"; }
  const invalidAfter = fdState(invalidFd!, "invalid_after_connect");
  output.failure = { invalidBefore, rawOpenInCallback, invalidAfter, failureOpen, postOpenError,
    errorCalls, callbackBeforeReturn, callbackCode, throwClass, rejectionClass };
  // An ordinary validation throw/rejection or post-open error is a distinct FAIL,
  // never substituted for the synchronous detached fromFd receipt.
  must(!failureOpen && !postOpenError && errorCalls === 1 && callbackBeforeReturn &&
    invalidBefore && rawOpenInCallback && invalidAfter, "from_fd_receipt_required");
  closeSync(invalidFd!); // Only this confirmed fixture-owned raw descriptor.
  const afterRawClose = fdState(invalidFd!, "invalid_after_raw_close");
  must(!afterRawClose, "raw_close_once");
  const freshFailure = openSync(reusePath, "r");
  const failureReused = freshFailure === invalidFd ? freshFailure : dupAt(freshFailure, invalidFd!);
  must(failureReused === invalidFd, "failure_fd_reuse");
  detachedSocket?.terminate();
  detachedSocket?.terminate();
  await Bun.sleep(20);
  const afterDetachedTerminate = fdState(failureReused, "invalid_reuse_after_repeat");
  const baselineStillOpen = fdState(baselineFd!, "baseline_after_rejection");
  const originalStillOpen = fdState(originalFd!, "original_after_rejection");
  must(afterDetachedTerminate && fstatSync(failureReused).isFile() && baselineStillOpen && originalStillOpen, "rejection_no_double_close");
  output.failure = { invalidBefore, rawOpenInCallback, invalidAfter, failureOpen, postOpenError,
    errorCalls, callbackBeforeReturn, callbackCode, throwClass, rejectionClass, afterRawClose,
    reusedExactNumber: failureReused === invalidFd, afterDetachedTerminate, baselineStillOpen, originalStillOpen };
  closeSync(failureReused);
  if (freshFailure !== failureReused) closeSync(freshFailure);
  closeSync(originalFd!); closeSync(baselineFd!);
  clearTimeout(timeout);
  report({ status: "PASS", ...output });
} catch (error) {
  clearTimeout(timeout);
  // Failed/uncertain transfers are left to child-process reaping, never raw-closed.
  report({ status: "FAIL", stage: error instanceof Error ? error.message : "unknown", ...output });
  process.exit(1);
}
