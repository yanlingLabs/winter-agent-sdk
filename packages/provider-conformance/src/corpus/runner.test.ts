// Phase 6 Task 3: the fake base and the corpus runner, proven by a SMOKE ECHO ADAPTER.
//
// A runner nobody has driven is a runner whose cases have never fired. So this file ships the
// smallest possible adapter -- an echo over the real loopback fake -- and runs the real corpus
// against it, so every one of the runner's own mechanisms (the case list, the missing-required
// failure, the capability-gated skip, the report) is exercised before any lane depends on it.
//
// Every fake is closed in a `finally` (via `withFake`), and every one binds 127.0.0.1 port 0.
import { test, expect, describe } from "bun:test";
import {
  errorResponse,
  jsonResponse,
  noRequestContains,
  redirectResponse,
  requestsTo,
  scenarioTable,
  sseResponse,
  stalledResponse,
  startFake,
  withFake,
  type RecordedRequest,
} from "../fakes/server.ts";
import { CORPUS_CASES, formatCorpusReport, runAdapterCorpus, type CorpusCaseId, type CorpusCaseImpl } from "./runner.ts";

describe("the fake base", () => {
  test("binds 127.0.0.1 on an ephemeral port and records every request in order", async () => {
    await withFake({ routes: [{ path: "/echo", handler: (_r, rec) => jsonResponse({ saw: rec.body }) }] }, async (fake) => {
      expect(fake.url.startsWith("http://127.0.0.1:")).toBe(true);
      const res = await fetch(`${fake.url}/echo?x=1`, { method: "POST", body: "hello" });
      expect(await res.json()).toEqual({ saw: "hello" });
      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0]).toMatchObject({ method: "POST", path: "/echo", search: "?x=1", body: "hello" });
    });
  });

  test("a request is logged BEFORE any route decides, so an unmatched path is still evidence", async () => {
    await withFake({ routes: [] }, async (fake) => {
      const res = await fetch(`${fake.url}/nowhere`);
      expect(res.status).toBe(404);
      expect(requestsTo(fake, "/nowhere")).toHaveLength(1);
    });
  });

  test("CREDENTIAL HEADERS ARE REDACTED as they are recorded -- the scheme survives, the material does not", async () => {
    // A request log printed by a failing assertion must never leak a key, even when a fixture is
    // careless with one. The scheme is kept because it is diagnostic; the material is not.
    const secret = "sk-should-never-be-logged";
    await withFake({ routes: [{ path: "/v1/x", handler: () => jsonResponse({}) }] }, async (fake) => {
      await fetch(`${fake.url}/v1/x`, { method: "POST", body: "{}", headers: { authorization: `Bearer ${secret}`, "x-api-key": secret, "x-trace": "keep-me" } });
      const rec = fake.requests[0]!;
      expect(rec.headers.authorization).toBe("Bearer ***");
      expect(rec.headers["x-api-key"]).toBe("***");
      expect(rec.headers["x-trace"]).toBe("keep-me");
      expect(JSON.stringify(rec)).not.toContain(secret);
      expect(noRequestContains(fake, secret)).toBe(true);
    });
  });

  test("noRequestContains finds a marker that IS present -- the positive control for the hermeticity negative", async () => {
    await withFake({ routes: [{ path: "/v1/x", handler: () => jsonResponse({}) }] }, async (fake) => {
      await fetch(`${fake.url}/v1/x`, { method: "POST", body: JSON.stringify({ marker: "MARKER-1" }) });
      expect(noRequestContains(fake, "MARKER-1")).toBe(false);
      expect(noRequestContains(fake, "MARKER-2")).toBe(true);
    });
  });

  test("close() is idempotent-safe and enforces its deadline", async () => {
    const fake = await startFake({ routes: [] });
    await fake.close();
    // A second close on a stopped server must not hang the runner either.
    await fake.close();
  });
});

describe("the SSE helper and the response primitives", () => {
  test("frames arrive in order, with the event name when one is given", async () => {
    const frames = [{ event: "message_start", data: '{"a":1}' }, { data: '{"b":2}' }];
    await withFake({ routes: [{ path: "/stream", handler: () => sseResponse(frames) }] }, async (fake) => {
      const text = await (await fetch(`${fake.url}/stream`)).text();
      expect(text).toBe('event: message_start\ndata: {"a":1}\n\ndata: {"b":2}\n\n');
    });
  });

  test("a SLOW frame delays the stream without stalling it", async () => {
    await withFake({ routes: [{ path: "/stream", handler: () => sseResponse([{ data: "a" }, { data: "b", delayMs: 120 }]) }] }, async (fake) => {
      const started = Date.now();
      const text = await (await fetch(`${fake.url}/stream`)).text();
      expect(Date.now() - started).toBeGreaterThanOrEqual(100);
      expect(text).toContain("data: b");
    });
  });

  test("a MID-STREAM DROP ends the stream WITHOUT the terminating frame", async () => {
    // What an SSE adapter can actually observe is the absent terminator, which is exactly what a
    // dropped upstream connection produces. Asserting on a client exception instead would be
    // asserting on Bun's own truncation behaviour, which (measured) does not throw.
    await withFake({ routes: [{ path: "/stream", handler: () => sseResponse([{ data: "a" }, { data: "b" }, { event: "done", data: "[DONE]" }], { dropAfter: 2 }) }] }, async (fake) => {
      const text = await (await fetch(`${fake.url}/stream`)).text();
      expect(text).toContain("data: a");
      expect(text).toContain("data: b");
      expect(text).not.toContain("[DONE]");
    });
  });

  test("an error status carries its headers -- the Retry-After / ratelimit shape", async () => {
    await withFake(
      { routes: [{ path: "/v1/x", handler: () => errorResponse(429, { error: { type: "rate_limit_error" } }, { "retry-after": "2", "anthropic-ratelimit-unified-status": "rejected" }) }] },
      async (fake) => {
        const res = await fetch(`${fake.url}/v1/x`);
        expect(res.status).toBe(429);
        expect(res.headers.get("retry-after")).toBe("2");
        expect(res.headers.get("anthropic-ratelimit-unified-status")).toBe("rejected");
      },
    );
  });

  test("a redirect is expressible ABSOLUTE, so a cross-origin hop can be scripted", async () => {
    // The endpoint policy's own rules -- no credential forwarding across an origin change, and an
    // outright refusal for a redirect carrying a body -- cannot be exercised with a relative Location.
    await withFake({ routes: [{ path: "/from", handler: () => redirectResponse("http://127.0.0.1:9/to", 307) }] }, async (fake) => {
      const res = await fetch(`${fake.url}/from`, { redirect: "manual" });
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe("http://127.0.0.1:9/to");
    });
  });

  test("a STALLED response opens and then writes nothing, bounded so it cannot outlive its test", async () => {
    await withFake({ routes: [{ path: "/stall", handler: () => stalledResponse(150) }] }, async (fake) => {
      const started = Date.now();
      await (await fetch(`${fake.url}/stall`)).text();
      expect(Date.now() - started).toBeGreaterThanOrEqual(120);
    });
  });
});

describe("the model-keyed scenario table", () => {
  const modelOf = (rec: RecordedRequest): string | undefined => {
    try {
      return (JSON.parse(rec.body) as { model?: string }).model;
    } catch {
      return undefined;
    }
  };

  test("one fake serves a whole corpus: each model id picks its own behaviour", async () => {
    const handler = scenarioTable({
      modelOf,
      scenarios: {
        "ok-model": () => jsonResponse({ ok: true }),
        "auth-model": () => errorResponse(401, { error: { type: "authentication_error" } }),
      },
    });
    await withFake({ routes: [{ path: "/v1/messages", handler }] }, async (fake) => {
      expect((await fetch(`${fake.url}/v1/messages`, { method: "POST", body: JSON.stringify({ model: "ok-model" }) })).status).toBe(200);
      expect((await fetch(`${fake.url}/v1/messages`, { method: "POST", body: JSON.stringify({ model: "auth-model" }) })).status).toBe(401);
    });
  });

  test("an ARRAY entry is indexed by attempt and its LAST element repeats -- '529 then 200 forever'", async () => {
    const handler = scenarioTable({ modelOf, scenarios: { flaky: [errorResponse(529, { error: {} }), jsonResponse({ ok: true })] } });
    await withFake({ routes: [{ path: "/v1/messages", handler }] }, async (fake) => {
      const post = () => fetch(`${fake.url}/v1/messages`, { method: "POST", body: JSON.stringify({ model: "flaky" }) });
      expect((await post()).status).toBe(529);
      expect((await post()).status).toBe(200);
      expect((await post()).status).toBe(200);
    });
  });

  test("an unknown model is a LOUD, assertable 400 rather than a silent default", async () => {
    const handler = scenarioTable({ modelOf, scenarios: {} });
    await withFake({ routes: [{ path: "/v1/messages", handler }] }, async (fake) => {
      const res = await fetch(`${fake.url}/v1/messages`, { method: "POST", body: JSON.stringify({ model: "nope" }) });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("nope");
    });
  });
});

// --- the smoke echo adapter --------------------------------------------------------------------------
//
// The smallest thing that can answer every case: a POST that echoes what it was asked. It exists to
// prove the RUNNER, not to model any real family -- which is exactly why it is here rather than in a
// lane's own file.

function echoCases(): Record<CorpusCaseId, CorpusCaseImpl> {
  const out = {} as Record<CorpusCaseId, CorpusCaseImpl>;
  for (const spec of CORPUS_CASES) {
    out[spec.id] = async ({ fake, model }) => {
      const res = await fetch(`${fake.url}/echo`, { method: "POST", body: JSON.stringify({ model, case: spec.id }) });
      const seen = (await res.json()) as { case: string };
      // The assertion is on what the FAKE received, not on what the caller believed it sent.
      if (seen.case !== spec.id) throw new Error(`echo mismatch for ${spec.id}`);
    };
  }
  return out;
}

describe("runAdapterCorpus", () => {
  test("EVERY WS-13 §13 case fires, and the report says so", async () => {
    await withFake({ routes: [{ path: "/echo", handler: (_r, rec) => jsonResponse(JSON.parse(rec.body)) }] }, async (fake) => {
      const report = await runAdapterCorpus({ adapter: "smoke-echo", fake, model: "echo-model", cases: echoCases() });
      expect(report.ok).toBe(true);
      expect(report.outcomes).toHaveLength(CORPUS_CASES.length);
      expect(report.outcomes.every((o) => o.status === "passed")).toBe(true);
      // One request per case: the cases genuinely ran against the wire rather than being counted.
      expect(requestsTo(fake, "/echo")).toHaveLength(CORPUS_CASES.length);
    });
  });

  test("a MISSING required case is reported as `missing` and fails the run", async () => {
    // "The corpus passed" has to mean "every question was asked", or WS-13 §13's promotion rule means
    // nothing -- so an absent required case is a failure the runner reports, not a silence.
    await withFake({ routes: [{ path: "/echo", handler: (_r, rec) => jsonResponse(JSON.parse(rec.body)) }] }, async (fake) => {
      const cases = echoCases();
      delete (cases as Partial<Record<CorpusCaseId, CorpusCaseImpl>>)["usage-accounting"];
      const report = await runAdapterCorpus({ adapter: "smoke-echo", fake, model: "echo-model", cases });
      expect(report.ok).toBe(false);
      expect(report.outcomes.find((o) => o.id === "usage-accounting")).toMatchObject({ status: "missing" });
      expect(formatCorpusReport(report)).toContain("FAILED");
    });
  });

  test("a MISSING capability-gated case is a skip, and a skip does not block a pass", async () => {
    await withFake({ routes: [{ path: "/echo", handler: (_r, rec) => jsonResponse(JSON.parse(rec.body)) }] }, async (fake) => {
      const cases = echoCases();
      delete (cases as Partial<Record<CorpusCaseId, CorpusCaseImpl>>)["vision-where-advertised"];
      const report = await runAdapterCorpus({ adapter: "smoke-echo", fake, model: "echo-model", cases });
      expect(report.ok).toBe(true);
      expect(report.outcomes.find((o) => o.id === "vision-where-advertised")).toMatchObject({ status: "skipped" });
    });
  });

  test("an explicit `{ skipped }` records the REASON -- a fact about the model, not a declined case", async () => {
    await withFake({ routes: [{ path: "/echo", handler: (_r, rec) => jsonResponse(JSON.parse(rec.body)) }] }, async (fake) => {
      const cases = { ...echoCases(), "effort-mapping": async () => ({ skipped: "this model declares no effort vocabulary" }) };
      const report = await runAdapterCorpus({ adapter: "smoke-echo", fake, model: "echo-model", cases });
      expect(report.ok).toBe(true);
      expect(report.outcomes.find((o) => o.id === "effort-mapping")).toEqual({ id: "effort-mapping", status: "skipped", detail: "this model declares no effort vocabulary" });
    });
  });

  test("EVERY case runs even after one fails -- a corpus is not a bisect", async () => {
    await withFake({ routes: [{ path: "/echo", handler: (_r, rec) => jsonResponse(JSON.parse(rec.body)) }] }, async (fake) => {
      const cases = { ...echoCases(), "streaming-order": async () => { throw new Error("deliberate"); } };
      const report = await runAdapterCorpus({ adapter: "smoke-echo", fake, model: "echo-model", cases });
      expect(report.ok).toBe(false);
      expect(report.outcomes.find((o) => o.id === "streaming-order")).toMatchObject({ status: "failed", detail: "deliberate" });
      expect(report.outcomes.filter((o) => o.status === "passed")).toHaveLength(CORPUS_CASES.length - 1);
    });
  });

  test("the case list covers WS-13 §13's own list, with stable ids and no duplicates", () => {
    const ids = CORPUS_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const spec of CORPUS_CASES) {
      expect(spec.question.length).toBeGreaterThan(20); // each case says what it PROVES, not just what it is called
      expect(["required", "capability-gated"]).toContain(spec.requirement);
    }
    // The hard negatives WS-13 §13 names explicitly are present as their own cases, not folded into
    // a neighbour where they could quietly stop being asked.
    expect(ids).toContain("no-silent-tool-dropping");
    expect(ids).toContain("retry-after-no-replay");
  });
});
