// Phase 6 Task 6 (Lane B): a stalled SSE response whose bound does NOT poison an unrelated test.
//
// WHY THIS EXISTS, stated plainly because it is a workaround for a SPINE DEFECT rather than a design
// choice. `fakes/server.ts`'s own `stalledResponse` is FROZEN (R6-12) and schedules its bound as:
//
//     setTimeout(() => controller.close(), holdMs);
//
// By the time that timer fires, the stall watchdog under test has long since abandoned the stream
// and `withFake` has torn the server down with `closeActiveConnections: true`. `close()` on an
// already-closed controller THROWS -- from inside a timer callback, so nothing catches it, and Bun's
// runner attributes the resulting `TypeError: Invalid state: Controller is already closed` to
// WHICHEVER TEST HAPPENS TO BE RUNNING `holdMs` later. Measured on this branch: two consecutive
// full-suite runs failed four and then three tests, in `tools/impl/monitor.test.ts` and a worktree
// suite respectively -- different files each time, all passing in isolation, none related to this
// lane. Reproduced in nine lines (a fetch abandoned mid-stalled-response plus a neighbouring test).
//
// THE FIX IN THE FROZEN FILE IS ONE LINE -- wrap that `close()` in try/catch, and ideally clear the
// timer on `cancel` -- and it is reported to the controller rather than made here. This helper is
// the same primitive with both guards, so THIS lane's stall scenarios cannot poison anything while
// that decision is pending.
/**
 * A response that opens and then writes nothing, bounded by `holdMs`.
 *
 * The bound is kept (a BROKEN watchdog should fail its test on an explicable timeout rather than
 * hang the runner) but both of its hazards are closed: the close is guarded, and the timer is
 * cleared the moment the consumer cancels -- which is the normal case, since a working watchdog
 * abandons the stream long before `holdMs`.
 */
export function stalledStreamResponse(holdMs = 2_000): Response {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(": open\n\n"));
      timer = setTimeout(() => {
        try {
          controller.close();
        } catch {
          // Already closed, errored, or cancelled -- which is the EXPECTED state here, because a
          // working stall watchdog abandoned this stream a long time ago. Throwing from a timer
          // callback is what makes this an unrelated test's failure instead of a no-op.
        }
      }, holdMs);
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}
