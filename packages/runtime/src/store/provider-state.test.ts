// Phase 6 Task 3 (R6-7): the provider-state sidecar -- codec, write-ahead ORDERING, the crash pairs,
// the child path, and the external-store subpath door.
//
// The ordering tests run through `resolveEngineSession`, not a bare `TranscriptWriter`, on purpose:
// the production path wraps the writer in `withPermissionJournal`, whose forwards are hand-written
// arrow functions. A wrapper that forgot to forward the new `opts` argument would mint a fresh uuid
// for every assistant entry and break every sidecar anchor with nothing failing anywhere -- exactly
// the seam-drop class that file's own header already warns about.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compatibilityKeys, type SessionKey, type SessionStore, type SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";
import {
  PROVIDER_STATE_ENTRY_TYPE,
  PROVIDER_STATE_SUBPATH,
  appendProviderState,
  buildContinuationChain,
  providerStateSidecarPath,
  readProviderState,
  toProviderStateRecord,
  type ProviderStateRecord,
} from "./provider-state.ts";
import { createFileProviderStateSink, createStoreProviderStateSink, resolveEngineSession, RUNTIME_ENGINE_VERSION } from "./dialect.ts";

function withTempHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "winter-p6-ps-"));
  return (async () => {
    try {
      return await fn(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  })();
}

const BASE = { sessionId: "sess", provider: "openai", model: "openai/o-test", family: "openai", itemIndex: 0 } as const;

describe("the sidecar file: paths, permissions, bounded repair", () => {
  test("the main path is the transcript's neighbour and the child path is the CHILD transcript's neighbour", () => {
    expect(providerStateSidecarPath("/a/b/sess-1.jsonl")).toBe("/a/b/sess-1.provider-state.jsonl");
    // dialect.ts's `childTranscriptSubpath` yields `subagents/agent-<id>`; the compat store writes it
    // at `<sessionId>/subagents/agent-<id>.jsonl`, so deriving from the transcript path (rather than
    // rebuilding a second path shape) puts the child sidecar exactly beside its own transcript.
    expect(providerStateSidecarPath("/a/b/sess-1/subagents/agent-7.jsonl")).toBe("/a/b/sess-1/subagents/agent-7.provider-state.jsonl");
  });

  test("append is 0600 and read round-trips every record", () =>
    withTempHome((home) => {
      const path = join(home, "s.provider-state.jsonl");
      const one = appendProviderState(path, { ...BASE, anchorUuid: "a-1", kind: "origin", payload: {} });
      const two = appendProviderState(path, { ...BASE, anchorUuid: "a-1", itemIndex: 1, kind: "native-state", payload: { items: ["opaque-1"] } });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readProviderState(path)).toEqual([one, two]);
      expect(one.uuid).not.toBe(two.uuid);
    }));

  test("bounded repair drops a TRUNCATED final line and keeps every earlier record", () =>
    withTempHome((home) => {
      const path = join(home, "s.provider-state.jsonl");
      const kept = appendProviderState(path, { ...BASE, anchorUuid: "a-1", kind: "origin", payload: {} });
      // The crash write-ahead makes likely: the process died mid-`writeSync`.
      appendFileSync(path, '{"type":"winter_provider_state","uuid":"partial"');
      expect(readProviderState(path)).toEqual([kept]);
    }));

  test("a malformed line ANYWHERE is skipped, not fatal, and a foreign entry type is not a record", () =>
    withTempHome((home) => {
      const path = join(home, "s.provider-state.jsonl");
      const first = toProviderStateRecord({ ...BASE, anchorUuid: "a-1", kind: "origin", payload: {} });
      const last = toProviderStateRecord({ ...BASE, anchorUuid: "a-2", kind: "origin", payload: {} });
      writeFileSync(path, `${JSON.stringify(first)}\nnot json at all\n${JSON.stringify({ type: "something_else", uuid: "x" })}\n${JSON.stringify(last)}\n`);
      expect(readProviderState(path).map((r) => r.anchorUuid)).toEqual(["a-1", "a-2"]);
    }));

  test("a missing sidecar is an EMPTY chain, never a throw", () =>
    withTempHome((home) => {
      expect(readProviderState(join(home, "absent.provider-state.jsonl"))).toEqual([]);
    }));
});

describe("R6-7 crash pairs", () => {
  const record = (anchorUuid: string, kind: ProviderStateRecord["kind"], payload: unknown): ProviderStateRecord =>
    toProviderStateRecord({ ...BASE, anchorUuid, kind, payload });

  test("a RECORD WITHOUT ITS ENTRY is ignored (the write-ahead crash): garbage-collectable, never fatal", () => {
    const chain = buildContinuationChain([record("never-appended", "origin", {}), record("real", "origin", {})], new Set(["real"]));
    expect([...chain.keys()]).toEqual(["real"]);
  });

  test("an ENTRY WITHOUT ITS RECORD is simply absent from the chain -- the caller degrades and warns", () => {
    const chain = buildContinuationChain([record("has-record", "origin", {})], new Set(["has-record", "no-record"]));
    expect(chain.has("no-record")).toBe(false);
    // "Degrade to summary-level" is available precisely because a `summary` record can exist without
    // an `origin` one: the message still gets its decoration, just not its exact native replay.
    const summaryOnly = buildContinuationChain([record("only-summary", "summary", { text: "it considered two options" })], new Set(["only-summary"]));
    expect(summaryOnly.get("only-summary")).toEqual({ summary: "it considered two options" });
    expect(summaryOnly.get("only-summary")?.origin).toBeUndefined();
  });

  test("a later record of the same kind supersedes the earlier one for the same anchor", () => {
    const chain = buildContinuationChain([record("a", "native-state", { items: ["old"] }), record("a", "native-state", { items: ["new"] })], new Set(["a"]));
    expect(chain.get("a")?.nativeState?.items).toEqual(["new"]);
  });

  test("a native-state record with no continuationDomain falls back to the FAMILY, never a fabricated domain", () => {
    const chain = buildContinuationChain([record("a", "native-state", { items: [1] })], new Set(["a"]));
    expect(chain.get("a")?.nativeState?.continuationDomain).toBe("openai");
  });
});

describe("R6-7 write-ahead ordering, through the REAL production persistence path", () => {
  test("the origin record is fsync'd BEFORE its assistant entry is appended, and carries the pre-allocated uuid", () =>
    withTempHome(async (home) => {
      const cwd = mkdtempSync(join(tmpdir(), "winter-p6-cwd-"));
      try {
        const resolved = await resolveEngineSession({
          config: { sessionId: "sess-w", cwd, model: "m", permissionMode: "default" } as never,
          resolveWinterHome: () => home,
          env: {},
        });
        const store = resolved.store!;
        expect(typeof store.recordProviderState).toBe("function");

        const uuid = "11111111-2222-4333-8444-555555555555";
        await store.recordProviderState!({ sessionId: "sess-w", anchorUuid: uuid, provider: "openai", model: "openai/o-test", family: "openai", itemIndex: 0, kind: "origin", payload: {} });
        await store.recordAssistantEntry([{ type: "text", text: "hi" }], { uuid });
        await store.flush?.();

        const projectKey = compatibilityKeys(cwd).transcriptProjectKey;
        const transcript = join(home, "projects", projectKey, "sess-w.jsonl");
        const sidecar = providerStateSidecarPath(transcript);
        expect(existsSync(sidecar)).toBe(true);

        // THE ANCHOR HELD. This is the assertion `withPermissionJournal`'s single-argument forward
        // would have broken silently: the writer would have minted its own uuid and the anchor would
        // point at nothing.
        const records = readProviderState(sidecar);
        expect(records).toHaveLength(1);
        expect(records[0]!.anchorUuid).toBe(uuid);
        const entries = readFileSync(transcript, "utf8").trim().split("\n").map((l) => JSON.parse(l) as SessionStoreEntry);
        const assistant = entries.find((e) => e.type === "assistant");
        expect(assistant?.uuid).toBe(uuid);

        // FILE ORDER, not merely both-present: the sidecar's mtime is at or before the transcript's,
        // and the sidecar exists at a point where the transcript has no such entry only if the write
        // happened first. The direct proof is the sequencing above (fsync completes before append is
        // even called); this is the durable corroboration.
        expect(statSync(sidecar).mtimeMs).toBeLessThanOrEqual(statSync(transcript).mtimeMs);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }));

  test("loadProviderState returns the chain a resume folds, and a non-persistent session has neither method", () =>
    withTempHome(async (home) => {
      const cwd = mkdtempSync(join(tmpdir(), "winter-p6-cwd2-"));
      try {
        const resolved = await resolveEngineSession({ config: { sessionId: "sess-r", cwd, model: "m", permissionMode: "default" } as never, resolveWinterHome: () => home, env: {} });
        await resolved.store!.recordProviderState!({ sessionId: "sess-r", anchorUuid: "a-1", provider: "openai", model: "openai/o-test", family: "openai", itemIndex: 0, kind: "origin", payload: {} });
        expect((await resolved.store!.loadProviderState!()).map((r) => r.anchorUuid)).toEqual(["a-1"]);

        const nonPersistent = await resolveEngineSession({ config: { sessionId: "x", cwd, model: "m", permissionMode: "default", persistSession: false } as never, resolveWinterHome: () => home, env: {} });
        expect(nonPersistent.store).toBeUndefined();
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }));
});

describe("R6-7a: the external SessionStore subpath door", () => {
  test("records go to the 'provider-state' subkey and resume LOADS that key directly, never listSubkeys", async () => {
    const appended: Array<{ key: SessionKey; entries: SessionStoreEntry[] }> = [];
    let listSubkeysCalls = 0;
    const rows = new Map<string, SessionStoreEntry[]>();
    const keyOf = (k: SessionKey): string => `${k.projectKey}|${k.sessionId}|${k.subpath ?? ""}`;
    const store: SessionStore = {
      async append(key, entries) {
        appended.push({ key, entries });
        rows.set(keyOf(key), [...(rows.get(keyOf(key)) ?? []), ...entries]);
      },
      async load(key) {
        return rows.get(keyOf(key)) ?? null;
      },
      async listSessions() {
        return [];
      },
      async delete() {},
      async listSubkeys() {
        listSubkeysCalls++;
        return [];
      },
    };

    const sink = createStoreProviderStateSink(store, { projectKey: "p", sessionId: "s" });
    const record = await sink.append({ ...BASE, anchorUuid: "a-1", kind: "origin", payload: {} });

    expect(appended).toHaveLength(1);
    expect(appended[0]!.key).toEqual({ projectKey: "p", sessionId: "s", subpath: PROVIDER_STATE_SUBPATH });
    // The SAME envelope as the neighbour file's -- a host swapping stores changes the transport only.
    expect(appended[0]!.entries[0]!.type).toBe(PROVIDER_STATE_ENTRY_TYPE);
    expect(appended[0]!.entries[0]!.uuid).toBe(record.uuid);

    // DEEP-EQUAL, never a hash: the pin says returned entries need only be deep-equal and the SDK
    // never byte-compares them (`sdk.d.ts:5302-5314`), so a store-backed chain cannot be
    // integrity-checked by hashing.
    expect(await sink.load()).toEqual([record]);
    expect(listSubkeysCalls).toBe(0);
  });

  test("the file sink and the store sink produce byte-identical envelopes for the same input", async () => {
    await withTempHome(async (home) => {
      const rows: SessionStoreEntry[] = [];
      const store: SessionStore = {
        async append(_key, entries) {
          rows.push(...entries);
        },
        async load() {
          return rows;
        },
        async listSessions() {
          return [];
        },
        async delete() {},
      };
      const fixed = { ...BASE, anchorUuid: "a-1", kind: "origin" as const, payload: {}, uuid: "fixed-uuid", timestamp: "2026-09-05T00:00:00.000Z" };
      const filePath = join(home, "s.provider-state.jsonl");
      const fileRecord = await createFileProviderStateSink(filePath).append(fixed);
      const storeRecord = await createStoreProviderStateSink(store, { projectKey: "p", sessionId: "s" }).append(fixed);
      expect(JSON.stringify(fileRecord)).toBe(JSON.stringify(storeRecord));
    });
  });
});

describe("the dialect record's provider identity (R6-9 / WS-16 §4)", () => {
  test("identity fields ride the dialect record, and authRef is the KIND only -- never material", () =>
    withTempHome(async (home) => {
      const cwd = mkdtempSync(join(tmpdir(), "winter-p6-cwd3-"));
      try {
        const resolved = await resolveEngineSession({ config: { sessionId: "sess-id", cwd, model: "m", permissionMode: "default" } as never, resolveWinterHome: () => home, env: {} });
        resolved.store!.setProviderIdentity!({
          providerId: "openai",
          modelKey: "openai/o-test",
          adapterId: "openai-responses",
          adapterVersion: "1.0.0",
          catalogVersion: "0.0.0-seed",
          authRefKind: "inline",
          classifierPin: "openai/o-classifier",
        });
        await resolved.store!.recordAssistantEntry([{ type: "text", text: "hi" }]);
        resolved.store!.recordProviderSwitch!({ from: "openai/o-test", to: "openai/o-fallback", reason: "fallback" });
        await resolved.store!.recordAssistantEntry([{ type: "text", text: "again" }]);

        const projectKey = compatibilityKeys(cwd).transcriptProjectKey;
        const summary = JSON.parse(readFileSync(join(home, "projects", projectKey, "sess-id.summary.json"), "utf8")) as Record<string, unknown>;
        expect(summary.providerId).toBe("openai");
        expect(summary.modelKey).toBe("openai/o-test");
        expect(summary.adapterId).toBe("openai-responses");
        expect(summary.adapterVersion).toBe("1.0.0");
        expect(summary.catalogVersion).toBe("0.0.0-seed");
        expect(summary.classifierPin).toBe("openai/o-classifier");
        // R6-10: an `inline` credential is a host responsibility, never persisted. The record says
        // WHICH KIND authenticated the session and nothing more.
        expect(summary.authRef).toBe("inline");
        expect(JSON.stringify(summary)).not.toContain("sk-");
        expect(summary.providerHistory).toEqual([{ from: "openai/o-test", to: "openai/o-fallback", reason: "fallback" }]);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }));
});

describe("R6-7 resume: the chain is re-attached, and a gap is REPORTED", () => {
  // Driven through a real `runEngine` over a real filesystem store: what is under test is that the
  // two halves written by two different mechanisms (the transcript and its neighbour sidecar) find
  // each other again on a resume, which no unit test of either half can show.
  test("a resumed assistant message regains its origin and native state, and a MISSING record warns", async () =>
    withTempHome(async (home) => {
      const cwd = mkdtempSync(join(tmpdir(), "winter-p6-resume-"));
      try {
        const { createInMemoryChannel } = await import("../protocol/channel.ts");
        const { runEngine } = await import("../engine.ts");
        const sessionId = "sess-resume";

        // Run 1: two assistant turns, but only the FIRST gets provider-state records -- the second is
        // the crash pair "entry without record", which is what the warning exists for.
        const first = await resolveEngineSession({ config: { sessionId, cwd, model: "m", permissionMode: "default" } as never, resolveWinterHome: () => home, env: {} });
        const store = first.store!;
        const anchorA = "aaaaaaaa-1111-4111-8111-111111111111";
        const anchorB = "bbbbbbbb-2222-4222-8222-222222222222";
        const base = { sessionId, provider: "openai", model: "openai/o-test", family: "openai", continuationDomain: "openai:responses" };
        await store.recordUserEntry("hello");
        await store.recordProviderState!({ ...base, anchorUuid: anchorA, itemIndex: 0, kind: "origin", payload: {} });
        await store.recordProviderState!({ ...base, anchorUuid: anchorA, itemIndex: 1, kind: "native-state", payload: { items: ["OPAQUE-ITEM"] } });
        await store.recordAssistantEntry([{ type: "text", text: "one" }], { uuid: anchorA });
        await store.recordUserEntry("again");
        await store.recordAssistantEntry([{ type: "text", text: "two" }], { uuid: anchorB });
        await store.flush?.();

        // Run 2: resume, and capture what the engine's own history looks like by the first generation.
        const { host, runtime } = createInMemoryChannel();
        let seen: Array<{ role: string; uuid?: string; origin?: unknown; nativeState?: unknown }> = [];
        const provider = {
          async generate(input: { messages: Array<{ role: string; uuid?: string; origin?: unknown; nativeState?: unknown }> }) {
            seen = input.messages;
            return { kind: "text" as const, text: "done" };
          },
        };
        const resumed = await resolveEngineSession({ config: { sessionId: "fresh", cwd, model: "m", permissionMode: "default", resume: sessionId } as never, resolveWinterHome: () => home, env: {} });
        const done = runEngine({
          config: resumed.config,
          input: runtime.input,
          output: runtime.output,
          provider,
          tools: { async execute() { return { output: "" }; } },
          store: resumed.store!,
          initialMessages: resumed.initialMessages,
        } as never);
        const frames: unknown[] = [];
        host.output.write({ type: "user", text: "go" });
        host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
        for await (const f of host.input) frames.push(f);
        await done;

        const withRecord = seen.find((m) => m.uuid === anchorA);
        expect(withRecord?.origin).toEqual({ providerId: "openai", modelKey: "openai/o-test", family: "openai", continuationDomain: "openai:responses" });
        expect(withRecord?.nativeState).toEqual({ family: "openai", continuationDomain: "openai:responses", items: ["OPAQUE-ITEM"] });

        const withoutRecord = seen.find((m) => m.uuid === anchorB);
        expect(withoutRecord).toBeDefined();
        expect(withoutRecord?.origin).toBeUndefined();

        // The gap is REPORTED, not silent -- and the report carries counts, never opaque state.
        const warning = frames
          .filter((f) => (f as { type?: string }).type === "data")
          .map((f) => (f as { message: Record<string, unknown> }).message)
          .find((m) => m.type === "system" && m.subtype === "continuity_warning") as Record<string, unknown> | undefined;
        expect(warning).toBeDefined();
        expect(warning!.warning).toBe("provider_state_missing");
        expect(String(warning!.detail)).toContain("1 resumed assistant message");
        expect(JSON.stringify(warning)).not.toContain("OPAQUE-ITEM");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }));
});

describe("R6-7 / I1: the identity block is what distinguishes a DELETED sidecar from one that never existed", () => {
  const IDENTITY = {
    providerId: "openai",
    modelKey: "openai/o-test",
    family: "openai",
    continuationDomain: "openai:responses",
    adapterId: "openai-responses",
    adapterVersion: "1.0.0",
    catalogVersion: "0.0.0-seed",
    authRefKind: "env",
  } as const;

  async function runSession(opts: { home: string; cwd: string; sessionId: string; resume?: string; identity?: typeof IDENTITY }): Promise<{ frames: unknown[] }> {
    const { createInMemoryChannel } = await import("../protocol/channel.ts");
    const { runEngine } = await import("../engine.ts");
    const resolved = await resolveEngineSession({
      config: { sessionId: opts.sessionId, cwd: opts.cwd, model: "m", permissionMode: "default", ...(opts.resume !== undefined ? { resume: opts.resume } : {}) } as never,
      resolveWinterHome: () => opts.home,
      env: {},
    });
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({
      config: resolved.config,
      input: runtime.input,
      output: runtime.output,
      provider: { async generate() { return { kind: "text" as const, text: "ok" }; } },
      tools: { async execute() { return { output: "" }; } },
      store: resolved.store!,
      initialMessages: resolved.initialMessages,
      ...(opts.identity !== undefined ? { providerIdentity: opts.identity } : {}),
    } as never);
    const frames: unknown[] = [];
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
    for await (const f of host.input) frames.push(f);
    await done;
    return { frames };
  }

  const warningsIn = (frames: unknown[]): Array<Record<string, unknown>> =>
    frames
      .filter((f) => (f as { type?: string }).type === "data")
      .map((f) => (f as { message: Record<string, unknown> }).message)
      .filter((m) => m.type === "system" && m.subtype === "continuity_warning");

  test("a session WITH a resolved identity writes the identity block to the dialect record", () =>
    withTempHome(async (home) => {
      const cwd = mkdtempSync(join(tmpdir(), "winter-p6-id-"));
      try {
        await runSession({ home, cwd, sessionId: "sess-id-a", identity: IDENTITY });
        const projectKey = compatibilityKeys(cwd).transcriptProjectKey;
        const summary = JSON.parse(readFileSync(join(home, "projects", projectKey, "sess-id-a.summary.json"), "utf8")) as Record<string, unknown>;
        // THE PRODUCTION CALL. `setProviderIdentity` existed, was implemented and was unit-tested,
        // and nothing called it -- so no session ever wrote this block.
        expect(summary.providerId).toBe("openai");
        expect(summary.modelKey).toBe("openai/o-test");
        expect(summary.adapterId).toBe("openai-responses");
        expect(summary.adapterVersion).toBe("1.0.0");
        expect(summary.catalogVersion).toBe("0.0.0-seed");
        expect(summary.authRef).toBe("env");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }));

  test("a DELETED sidecar resumes with a loss warning -- not silently", () =>
    withTempHome(async (home) => {
      const cwd = mkdtempSync(join(tmpdir(), "winter-p6-id-b-"));
      try {
        await runSession({ home, cwd, sessionId: "sess-id-b", identity: IDENTITY });
        const projectKey = compatibilityKeys(cwd).transcriptProjectKey;
        const sidecar = providerStateSidecarPath(join(home, "projects", projectKey, "sess-id-b.jsonl"));
        expect(existsSync(sidecar)).toBe(true);
        rmSync(sidecar); // the case R6-7's early return used to swallow

        const { frames } = await runSession({ home, cwd, sessionId: "fresh-b", resume: "sess-id-b" });
        const warnings = warningsIn(frames);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]!.warning).toBe("provider_state_deleted");
        expect(String(warnings[0]!.detail)).toContain("assistant message");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }));

  test("a PRE-P6 transcript (no identity block, no sidecar) resumes SILENTLY", () =>
    withTempHome(async (home) => {
      const cwd = mkdtempSync(join(tmpdir(), "winter-p6-id-c-"));
      try {
        // No `identity` -> no identity block and no records, exactly like every session written
        // before this phase. Warning on those would fire on essentially every resumed session.
        await runSession({ home, cwd, sessionId: "sess-id-c" });
        const { frames } = await runSession({ home, cwd, sessionId: "fresh-c", resume: "sess-id-c" });
        expect(warningsIn(frames)).toHaveLength(0);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }));
});

describe("round 2: a forked CHILD of a persisted parent emits NO continuity warning", () => {
  // The end-to-end leg (c). The two unit legs in `continuation-attach.test.ts` and the subpath guard
  // in `dialect.ts` each close half the mechanism; this asserts the whole path a real fork takes --
  // a child writer keyed on the PARENT's sessionId, its own empty sidecar, and inherited messages
  // that already carry `origin` -- produces no frame at all, on the parent's stream or anywhere.
  test("a child writer keyed on the parent's sessionId reports NO identity of its own", () =>
    withTempHome(async (home) => {
      const cwd = mkdtempSync(join(tmpdir(), "winter-p6-child-id-"));
      try {
        const { buildChildTranscriptWriter } = await import("./dialect.ts");
        const { WinterCompatibilitySessionStore } = await import("@yanlinglabs/winter-agent-sdk");
        const projectKey = compatibilityKeys(cwd).transcriptProjectKey;
        const store = new WinterCompatibilitySessionStore({ winterHome: home });

        // A PARENT with a written identity block…
        const parent = await resolveEngineSession({ config: { sessionId: "sess-parent", cwd, model: "m", permissionMode: "default" } as never, resolveWinterHome: () => home, env: {} });
        parent.store!.setProviderIdentity!({ providerId: "openai", modelKey: "openai/o-test", adapterId: "openai-responses", adapterVersion: "1.0.0", catalogVersion: "0.0.0-seed", authRefKind: "env" });
        await parent.store!.recordAssistantEntry([{ type: "text", text: "one" }]);
        expect(await parent.store!.loadProviderIdentity!()).toEqual({ providerId: "openai", modelKey: "openai/o-test" });

        // …and a CHILD whose key reuses that very sessionId with a subpath.
        const child = buildChildTranscriptWriter({ store, projectKey, parentSessionId: "sess-parent", agentId: "agent-1", parentToolUseId: "t1", cwd, winterHome: home });
        // Without the subpath guard this returns the PARENT's identity, and the child -- whose own
        // sidecar is legitimately empty -- is told the sidecar was DELETED.
        expect(await child.loadProviderIdentity()).toBeUndefined();
        expect(await child.loadProviderState()).toEqual([]);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }));

  test("a FORK inheriting annotated messages produces zero continuity warnings, while a genuinely deleted sidecar still warns", () =>
    withTempHome(async (home) => {
      const cwd = mkdtempSync(join(tmpdir(), "winter-p6-fork-warn-"));
      try {
        const { attachContinuationChain } = await import("./continuation-attach.ts");
        const warnings: unknown[] = [];
        const annotated = [
          { role: "assistant" as const, uuid: "a-1", origin: { providerId: "openai", modelKey: "openai/o-test", family: "openai" } },
          { role: "user" as const },
        ];
        // The child's own store: the parent's identity is NOT visible (leg (b)) and its sidecar is
        // empty by construction.
        await attachContinuationChain({
          messages: annotated,
          store: { loadProviderState: async () => [], loadProviderIdentity: async () => undefined },
          sessionId: "sess-parent",
          warn: (m) => warnings.push(m),
          newUuid: () => "u",
        });
        expect(warnings).toHaveLength(0);

        // …and even if leg (b) were bypassed, leg (a) alone holds: the inherited history is
        // provenance-complete, so the identity being visible changes nothing.
        await attachContinuationChain({
          messages: annotated,
          store: { loadProviderState: async () => [], loadProviderIdentity: async () => ({ providerId: "openai", modelKey: "openai/o-test" }) },
          sessionId: "sess-parent",
          warn: (m) => warnings.push(m),
          newUuid: () => "u",
        });
        expect(warnings).toHaveLength(0);

        // THE PARENT-SIDE CASE IS UNCHANGED: an UNANNOTATED history with an identity and no records
        // is still a deleted sidecar, and still warns.
        await attachContinuationChain({
          messages: [{ role: "assistant" as const, uuid: "a-9" }],
          store: { loadProviderState: async () => [], loadProviderIdentity: async () => ({ providerId: "openai", modelKey: "openai/o-test" }) },
          sessionId: "sess-parent",
          warn: (m) => warnings.push(m),
          newUuid: () => "u",
        });
        expect(warnings).toHaveLength(1);
        expect((warnings[0] as { warning: string }).warning).toBe("provider_state_deleted");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }));
});
