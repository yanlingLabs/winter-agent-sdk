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
