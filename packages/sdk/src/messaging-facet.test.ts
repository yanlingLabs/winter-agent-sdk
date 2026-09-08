// R-7b-4: `Query.messaging` end to end -- a real spawned `winter` session, a real child, the six
// `messaging.*` control subtypes, the real in-process adapter on the far side.
//
// WHY THESE FOUR MOMENTS. The facet exists so `@yanlinglabs/winter-runtime-sdk` can reach INSIDE a
// spawned Winter session from the host process. Each test drives one of the moments its
// RuntimeDirectory actually has (WS-15 §6.2's routing-behaviour table), at an OBSERVED point in the
// stream rather than after a timer:
//
//   * a RUNNING child -- synchronised on the child's own permission request. `canUseTool` is called
//     while the child sits blocked waiting for the answer, so "the child is running" is a fact the
//     harness OBSERVES rather than races for. `listReachable` and `steerChild` are asserted there.
//   * a TERMINAL child -- after the parent's turn result. The Agent call awaited the child, so by the
//     time that result arrives the child has settled. `resumeChild` is asserted there.
//   * `subscribeIdle` -- also on the terminal child, where WS-10 §14's answer is a typed REFUSAL
//     ("notify_when_idle targets a top-level session only"), which is the spec-correct outcome for
//     an agent target and the one a router must not mistake for success.
//   * `senderClass` -- twice, across a live `setPermissionMode`, because a class read once at spawn
//     would look identical to one read live and be wrong from the first mode switch onward.
//
// THE PROMPT IS AN ASYNC ITERABLE held open by a deferred, for a mechanical reason worth naming: a
// STRING prompt makes query() send `end_input` after the one turn, and `sendControlRequest` rejects
// once the generator has terminated -- so a facet call after the first result would fail on a closed
// connection rather than on anything about messaging.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type Query, type SdkMessage } from "./query.ts";
import { inMemoryProcess } from "winter-agent-runtime/testing";
import { testProviderByName, SUBAGENT_CHILD_PROBE_TEXT } from "winter-agent-runtime";
import type { GlobalAgentMessage, ListedRuntimeObject } from "./messaging/index.ts";
import type { MessagingIdleNoticePayload } from "./protocol/messaging.ts";
import { buildSessionAddress } from "./messaging/index.ts";

const FIXTURE_MODEL = "winter-test/echo";
// A plain fixture id, not an `s_<hex>` product id: a session id in that namespace makes the runtime
// look for an existing compatibility-store entry and refuse when there is none (measured, unrelated
// to messaging). Every assertion below only needs the id to be STABLE and to be what the child's
// canonical address is keyed on.
const SESSION_ID = "facet-fixture-session";

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A fully-addressed envelope from a synthetic HOST session -- what the router would construct. */
function envelope(overrides: Partial<GlobalAgentMessage> & { messageId: string; to: GlobalAgentMessage["to"] }): GlobalAgentMessage {
  return {
    from: buildSessionAddress("s_host_router"),
    fromGeneration: 0,
    toGeneration: 0,
    body: "wrap up when you can",
    notifyWhenIdle: false,
    createdAt: 0,
    expiresAt: 0,
    hopCount: 0,
    senderPermissionClass: "prompts",
    ...overrides,
  };
}

interface FacetRun {
  /** Every message the session yielded, in order. */
  messages: SdkMessage[];
  /** Whatever the scenario body collected. */
  observed: Record<string, unknown>;
}

/**
 * Drives one session with a streaming prompt, running `whileRunning` at the child's permission
 * request and `whenSettled` after the parent's turn result, then closes the input.
 *
 * Both callbacks are AWAITED before the run is allowed to proceed past their moment, which is what
 * makes the assertions deterministic: nothing else is happening on the wire while a facet call is in
 * flight.
 */
async function runFacetSession(opts: {
  whileRunning?: (q: Query, observed: Record<string, unknown>) => Promise<void>;
  whenSettled?: (q: Query, observed: Record<string, unknown>) => Promise<void>;
}): Promise<FacetRun> {
  const winterHome = mkdtempSync(join(tmpdir(), "winter-facet-"));
  const observed: Record<string, unknown> = {};
  const messages: SdkMessage[] = [];
  const done = deferred<void>();
  let q!: Query;
  try {
    async function* prompt(): AsyncGenerator<string> {
      yield "run the subagent";
      await done.promise; // held open so the facet can be called after the first turn settles
    }
    q = query({
      prompt: prompt(),
      options: {
        model: FIXTURE_MODEL,
        sessionId: SESSION_ID,
        allowedTools: ["Agent"],
        permissionMode: "default",
        // The child's own `ReadNotifications` call has no matching rule under `default`, so it
        // reaches this callback -- and the child is BLOCKED here, which is the observation the
        // running-child assertions need.
        canUseTool: async () => {
          if (opts.whileRunning) await opts.whileRunning(q, observed);
          return { behavior: "allow", updatedInput: {} };
        },
        spawnClaudeCodeProcess: (o) => inMemoryProcess(o.args, testProviderByName("subagentperm"), undefined, { ...o.env, WINTER_HOME: winterHome }),
      },
    });
    let settledOnce = false;
    for await (const msg of q) {
      messages.push(msg);
      if (msg.type === "result" && !settledOnce) {
        settledOnce = true;
        // NOT awaited, and this is the load-bearing detail of the whole harness: `query()`'s read
        // loop lives INSIDE the generator, so frames are only pumped while the consumer is awaiting
        // the next message. Awaiting a control call in this loop body deadlocks -- the very response
        // it waits for can only arrive through this loop. (`whileRunning` has no such problem:
        // `canUseTool` runs from a fire-and-forget control-request handler, off the pump.)
        void (async () => {
          try {
            // The Agent call awaited the child, so the child has settled by the time this arrives.
            if (opts.whenSettled) await opts.whenSettled(q, observed);
          } finally {
            done.resolve();
          }
        })();
      }
    }
  } finally {
    rmSync(winterHome, { recursive: true, force: true });
  }
  return { messages, observed };
}

/** The child's own row out of a `listReachable` answer -- there is exactly one agent in these runs. */
function childRow(rows: ListedRuntimeObject[]): ListedRuntimeObject {
  const agents = rows.filter((r) => r.objectKind === "agent");
  expect(agents).toHaveLength(1);
  return agents[0]!;
}

describe("Query.messaging: a spawned session's own children, reached from the host over the wire", () => {
  test("listReachable lists this session's RUNNING child with its canonical address and capabilities", async () => {
    const { observed } = await runFacetSession({
      whileRunning: async (q, o) => {
        o.running = await q.messaging.listReachable();
      },
    });
    const row = childRow(observed.running as ListedRuntimeObject[]);
    // The canonical address WS-10 §11 pins: `agent:<owning session>:<stable child id>`. The child id
    // is minted per run, so the shape and the owning session are what a golden can hold -- and both
    // are what the router's directory entry is keyed on.
    expect(row.address.startsWith(`agent:${SESSION_ID}:`)).toBe(true);
    expect(row.runtimeKind).toBe("winter-agent");
    expect(row.status).toBe("running");
    // WS-10 §10.3, as the capability flags a router reads before choosing steer vs resume.
    expect(row.capabilities.message).toBe(true);
    expect(row.capabilities.resume).toBe(false);
    // WS-10 §14: a subagent is never a valid notify_when_idle target.
    expect(row.capabilities.notifyWhenIdle).toBe(false);
  });

  test("steerChild delivers into the RUNNING child, addressed by its bare stable id", async () => {
    const { observed } = await runFacetSession({
      whileRunning: async (q, o) => {
        const rows = await q.messaging.listReachable();
        const id = childRow(rows).address.split(":")[2]!;
        o.byBareId = await q.messaging.steerChild(id, envelope({ messageId: "host-msg-1", to: { objectKind: "agent", runtimeKind: "winter-agent", winterSessionId: SESSION_ID, childId: id } }));
        // ...and by the CANONICAL address, which is the form a router that already holds a directory
        // entry would use. Both forms must reach the same child (`resolveFacetTarget`'s one rule).
        o.byAddress = await q.messaging.steerChild(childRow(rows).address, envelope({ messageId: "host-msg-2", to: { objectKind: "agent", runtimeKind: "winter-agent", winterSessionId: SESSION_ID, childId: id } }));
      },
    });
    expect(observed.byBareId).toEqual({ status: "delivered", messageId: "host-msg-1" });
    expect(observed.byAddress).toEqual({ status: "delivered", messageId: "host-msg-2" });
  });

  test("steerChild on a TERMINAL child is not_found -- never silently upgraded to a resume (WS-10 §10.3)", async () => {
    const { observed } = await runFacetSession({
      whenSettled: async (q, o) => {
        const rows = await q.messaging.listReachable();
        const row = childRow(rows);
        o.terminalRow = row;
        const id = row.address.split(":")[2]!;
        o.steerAfterExit = await q.messaging.steerChild(id, envelope({ messageId: "host-msg-3", to: { objectKind: "agent", runtimeKind: "winter-agent", winterSessionId: SESSION_ID, childId: id } }));
      },
    });
    const row = observed.terminalRow as ListedRuntimeObject;
    expect(row.status).toBe("exited");
    expect(row.capabilities.resume).toBe(true);
    expect(row.capabilities.message).toBe(false);
    const outcome = observed.steerAfterExit as { status: string; reason?: string };
    expect(outcome.status).toBe("not_found");
    expect(outcome.reason).toContain("not running");
  });

  test("resumeChild resumes the TERMINAL child, and subscribeIdle on an agent is the typed WS-10 §14 refusal", async () => {
    const { observed } = await runFacetSession({
      whenSettled: async (q, o) => {
        const id = childRow(await q.messaging.listReachable()).address.split(":")[2]!;
        o.resume = await q.messaging.resumeChild(id, envelope({ messageId: "host-msg-4", to: { objectKind: "agent", runtimeKind: "winter-agent", winterSessionId: SESSION_ID, childId: id } }));
        o.idle = await q.messaging.subscribeIdle(id, { messageId: "host-msg-5", subscriberSessionId: "s_host_router" });
      },
    });
    expect((observed.resume as { status: string }).status).toBe("resumed_and_delivered");
    // WS-10 §14: "subagents ... MUST refuse the entire call." A router that read this as a success
    // would wait forever for a notice that is never coming.
    const idle = observed.idle as { status: string; reason?: string };
    expect(idle.status).toBe("refused");
    expect(idle.reason).toContain("top-level session only");
    expect((observed.idle as { messageId: string }).messageId).toBe("host-msg-5");
  });

  test("senderClass reports this session's LIVE permission class, and follows a mode switch", async () => {
    const { observed } = await runFacetSession({
      whileRunning: async (q, o) => {
        // `default` is a PROMPTING mode (WS-10 §13's first row).
        o.before = await q.messaging.senderClass();
        // `plan` classifies as bypassing only when bypass is AVAILABLE to the session; this one was
        // started without `allowDangerouslySkipPermissions`, so it stays "prompts" -- the negative
        // half of §13's own rule, and the one a mode-name-derived answer would get wrong.
        await q.setPermissionMode("plan");
        o.afterPlan = await q.messaging.senderClass();
      },
    });
    expect(observed.before).toBe("prompts");
    expect(observed.afterPlan).toBe("prompts");
  });

  test("a child of ANOTHER session is refused before any adapter call (WS-10 §10.3's owning-parent fence)", async () => {
    // The facet bypasses the router by design, and the reference adapter's `findChild` matches the
    // PROCESS-WIDE roster against the ADDRESS's own claimed parent -- it has no caller context to
    // compare it to. So the fence lives in the runtime's facet handler, and this is what proves a
    // host cannot reach across sessions through it. Moot under today's one-process-per-session spawn
    // topology; NOT moot for a daemon-backed in-process host, which is what the process-level
    // messaging runtime exists to serve.
    //
    // An `ok:false` control response, so the wrapper REJECTS -- a malformed call, never a
    // `not_found` outcome a router would read as "the child vanished" while still addressing the
    // wrong session.
    const { observed } = await runFacetSession({
      whileRunning: async (q, o) => {
        const foreign = { objectKind: "agent" as const, runtimeKind: "winter-agent" as const, winterSessionId: "s_other", parentWinterSessionId: "s_other", childId: "c1" };
        try {
          await q.messaging.steerChild("agent:s_other:c1", envelope({ messageId: "host-msg-6", to: foreign }));
          o.crossSession = "RESOLVED -- the fence is gone";
        } catch (err) {
          o.crossSession = err instanceof Error ? err.message : String(err);
        }
      },
    });
    expect(observed.crossSession).toContain("OWNING parent");
    expect(observed.crossSession).toContain("another session");
  });

  test("notify_when_idle round trip: subscribe -> the turn ends -> exactly ONE live notice, and the drain returns the SAME record once", async () => {
    // The gap this closes: before it, a host could be told `subscribed` and then never hear
    // anything -- the reference adapter files WS-10 §14's notice in an IN-PROCESS queue that nothing
    // drained and no frame carried, so `subscribed` was a promise the facet could not keep.
    //
    // Both halves, in one run, because they are the same notice: the LIVE
    // `messaging.idle_notice` frame and the CATCH-UP `messaging.read_notifications` drain, correlated
    // by `notification_id`. The live forward deliberately does NOT consume the entry -- that is what
    // makes WS-15 §6.4's "a host that was not listening collects what it missed" possible.
    const live: MessagingIdleNoticePayload[] = [];
    const { observed } = await runFacetSession({
      whileRunning: async (q, o) => {
        q.messaging.onIdleNotice((payload) => live.push(payload));
        // The SESSION, not the child: WS-10 §14 refuses a subagent target outright, so the only
        // legitimate target inside a spawned session is the session itself.
        o.subscribed = await q.messaging.subscribeIdle(`session:${SESSION_ID}`, { messageId: "host-msg-idle-1" });
      },
      // The turn has ended by the time this runs, so the notice has already been queued and forwarded.
      whenSettled: async (q, o) => {
        o.firstDrain = await q.messaging.readNotifications();
        o.secondDrain = await q.messaging.readNotifications();
      },
    });

    // The subscription was ACCEPTED -- the self-peer registration is what makes a session a
    // legitimate, idle-signalling target of its own adapter.
    expect(observed.subscribed).toEqual({ status: "subscribed", messageId: "host-msg-idle-1" });

    // EXACTLY ONE live notice. WS-10 §14's "at most one notice" is structural on the runtime side (a
    // fired subscription is removed and can never fire again); this is the wire-level proof.
    expect(live).toHaveLength(1);
    expect(live[0]!.subscriberSessionId).toBe(SESSION_ID);
    expect(live[0]!.notice.content).toContain("idle");

    // The drain returns the SAME record once...
    const first = observed.firstDrain as { notifications: Array<{ notification_id: string }>; remaining: number };
    expect(first.notifications).toHaveLength(1);
    expect(first.remaining).toBe(0);
    expect(first.notifications[0]!.notification_id).toBe(live[0]!.notice.notification_id);
    // ...and then nothing: a drain is the acknowledgement.
    expect(observed.secondDrain).toEqual({ notifications: [], remaining: 0 });
  });

  test("a session nobody subscribed to answers an EMPTY drain and never becomes a peer -- the addendum costs an unsubscribed session nothing", async () => {
    // The negative control for the lazy self-peer registration: without it, every session would start
    // listing itself in `list_reachable`, which is a behaviour change for every host that never asked
    // for an idle notice (and would have moved the differential golden's own `facet-1` answer).
    const { observed } = await runFacetSession({
      whenSettled: async (q, o) => {
        o.drain = await q.messaging.readNotifications();
        o.reachable = await q.messaging.listReachable();
      },
    });
    expect(observed.drain).toEqual({ notifications: [], remaining: 0 });
    expect((observed.reachable as ListedRuntimeObject[]).filter((r) => r.objectKind === "session")).toEqual([]);
  });

  test("the child really ran: the facet observed a session that produced a normal terminal result", async () => {
    // A negative control for every test above -- each asserts on a child, so a run in which the
    // Agent tool never spawned one (the "no child engine factory" failure) has to be excluded.
    const { messages } = await runFacetSession({});
    const results = messages.filter((m) => m.type === "result");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(messages)).not.toContain("no child engine factory");
    expect(JSON.stringify(messages)).toContain(SUBAGENT_CHILD_PROBE_TEXT);
  });
});
