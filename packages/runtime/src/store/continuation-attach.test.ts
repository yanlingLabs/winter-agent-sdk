// Phase 6 Task 3 (M8): the extracted resume re-attachment, tested as the pure function it is.
//
// `provider-state.test.ts` still drives the same logic through a real `runEngine` over a real
// filesystem store -- that is what proves the two halves find each other on disk. These prove the
// DECISION TABLE, whose four outcomes are otherwise only reachable by arranging four sessions.
import { test, expect, describe } from "bun:test";
import type { ProtocolSdkMessage as SdkMessage } from "@yanlinglabs/winter-agent-sdk";
import { attachContinuationChain, type AttachableMessage, type ContinuationChainSource } from "./continuation-attach.ts";
import { toProviderStateRecord, type ProviderStateRecord } from "./provider-state.ts";

const record = (anchorUuid: string, kind: ProviderStateRecord["kind"], payload: unknown): ProviderStateRecord =>
  toProviderStateRecord({ sessionId: "s", anchorUuid, provider: "openai", model: "openai/o-test", family: "openai", continuationDomain: "openai:responses", itemIndex: 0, kind, payload });

async function attach(opts: {
  messages: AttachableMessage[];
  records?: ProviderStateRecord[] | (() => never);
  identity?: { providerId: string; modelKey: string };
  noIdentityMethod?: boolean;
}): Promise<{ messages: AttachableMessage[]; warnings: Array<Record<string, unknown>> }> {
  const warnings: Array<Record<string, unknown>> = [];
  const store: ContinuationChainSource = {
    async loadProviderState() {
      if (typeof opts.records === "function") return opts.records();
      return opts.records ?? [];
    },
    ...(opts.noIdentityMethod === true ? {} : { loadProviderIdentity: async () => opts.identity }),
  };
  await attachContinuationChain({
    messages: opts.messages,
    store,
    sessionId: "s",
    warn: (m: SdkMessage) => warnings.push(m as unknown as Record<string, unknown>),
    newUuid: () => "fixed-uuid",
  });
  return { messages: opts.messages, warnings };
}

describe("the decision table: four outcomes, and only one of them is silence-by-default", () => {
  test("records present -> origin and native state are re-attached, no warning", async () => {
    const messages: AttachableMessage[] = [{ role: "assistant", uuid: "a-1" }];
    const { warnings } = await attach({ messages, records: [record("a-1", "origin", {}), record("a-1", "native-state", { items: ["OPAQUE"] })] });
    expect(messages[0]!.origin).toEqual({ providerId: "openai", modelKey: "openai/o-test", family: "openai", continuationDomain: "openai:responses" });
    expect(messages[0]!.nativeState).toEqual({ family: "openai", continuationDomain: "openai:responses", items: ["OPAQUE"] });
    expect(warnings).toHaveLength(0);
  });

  test("SOME anchors missing their origin -> those degrade, and the count is reported", async () => {
    const messages: AttachableMessage[] = [
      { role: "assistant", uuid: "a-1" },
      { role: "assistant", uuid: "a-2" },
      { role: "user" },
    ];
    const { warnings } = await attach({ messages, records: [record("a-1", "origin", {})] });
    expect(messages[0]!.origin).toBeDefined();
    expect(messages[1]!.origin).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.warning).toBe("provider_state_missing");
    expect(String(warnings[0]!.detail)).toContain("1 resumed assistant message");
  });

  test("ZERO records WITH an identity block -> the sidecar was DELETED, and the session says so", async () => {
    const { warnings } = await attach({ messages: [{ role: "assistant", uuid: "a-1" }, { role: "assistant", uuid: "a-2" }], records: [], identity: { providerId: "openai", modelKey: "openai/o-test" } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.warning).toBe("provider_state_deleted");
    expect(String(warnings[0]!.detail)).toContain("2 resumed assistant messages");
  });

  test("ZERO records with NO identity block -> a pre-P6 transcript, and silence is correct", async () => {
    // Warning here would fire on essentially every resumed session in the product and train a reader
    // to ignore the frame -- which is what would make it useless on the day it means something.
    const { warnings } = await attach({ messages: [{ role: "assistant", uuid: "a-1" }], records: [] });
    expect(warnings).toHaveLength(0);
  });

  test("a store with no `loadProviderIdentity` at all stays silent too", async () => {
    // A test double, or a store written before the method existed: "unknown" is not "deleted".
    const { warnings } = await attach({ messages: [{ role: "assistant", uuid: "a-1" }], records: [], noIdentityMethod: true });
    expect(warnings).toHaveLength(0);
  });

  test("an UNREADABLE sidecar warns on its own channel -- degraded, not failed", async () => {
    const { warnings } = await attach({
      messages: [{ role: "assistant", uuid: "a-1" }],
      records: () => {
        throw new Error("EIO");
      },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.warning).toBe("sidecar_unreadable");
    // The underlying error is NOT reproduced: this string is a frame and a log line.
    expect(String(warnings[0]!.detail)).not.toContain("EIO");
  });
});

describe("the guards", () => {
  test("a history with no ASSISTANT anchors does nothing at all", async () => {
    // A user-only history has no anchor to key on, so there is nothing to attach and nothing to warn
    // about -- not even the deleted-sidecar case, which counts anchors.
    const { warnings } = await attach({ messages: [{ role: "user" }, { role: "tool" }], records: [], identity: { providerId: "p", modelKey: "p/m" } });
    expect(warnings).toHaveLength(0);
  });

  test("an EMPTY history is a no-op even with a full store", async () => {
    const { warnings } = await attach({ messages: [], records: [record("a-1", "origin", {})] });
    expect(warnings).toHaveLength(0);
  });

  test("a store with no `loadProviderState` is a no-op (a non-persistent session)", async () => {
    const warnings: SdkMessage[] = [];
    await attachContinuationChain({ messages: [{ role: "assistant", uuid: "a-1" }], store: {}, sessionId: "s", warn: (m) => warnings.push(m), newUuid: () => "u" });
    expect(warnings).toHaveLength(0);
  });

  test("the warning detail carries COUNTS only -- never the opaque state it is about", async () => {
    const messages: AttachableMessage[] = [{ role: "assistant", uuid: "a-1" }, { role: "assistant", uuid: "a-2" }];
    const { warnings } = await attach({ messages, records: [record("a-1", "native-state", { items: ["ENCRYPTED-OPAQUE-ITEM"] })] });
    expect(JSON.stringify(warnings)).not.toContain("ENCRYPTED-OPAQUE-ITEM");
  });
});

describe("round 2: a FORKED CHILD must not be told its parent's sidecar was deleted", () => {
  // THE MECHANISM, stated because it is not obvious from any one file. A child writer's key reuses
  // the PARENT's `sessionId` with a `subpath` (`buildChildTranscriptWriter`), so a summary lookup by
  // sessionId matches the PARENT's row -- while the child's own fresh writer has zero records. Fork
  // inheritance hands the child the parent's ALREADY-ANNOTATED messages, whose assistant entries
  // carry uuids, so the anchor set is non-empty. Every precondition for `provider_state_deleted` is
  // therefore met by a perfectly healthy fork, and the frame escapes to the PARENT's host stream.
  //
  // Two independent legs close it, and both are asserted here: an in-memory `origin` is proof of
  // provenance regardless of what the sidecar says, and a subpath writer has no identity of its own.

  test("leg (a): an anchor that ALREADY carries `origin` in memory is never counted as deleted", async () => {
    // Inherited fork history is provenance-complete BY CONSTRUCTION -- the parent attached `origin`
    // before the fork copied it -- so a sidecar it was never written to says nothing about it.
    const messages: AttachableMessage[] = [
      { role: "assistant", uuid: "a-1", origin: { providerId: "openai", modelKey: "openai/o-test", family: "openai" } },
      { role: "assistant", uuid: "a-2", origin: { providerId: "openai", modelKey: "openai/o-test", family: "openai" } },
    ];
    const { warnings } = await attach({ messages, records: [], identity: { providerId: "openai", modelKey: "openai/o-test" } });
    expect(warnings).toHaveLength(0);
  });

  test("leg (a): a MIXED history still warns for the anchors that genuinely have no provenance", async () => {
    // The leg must not become a blanket suppression: an anchor with no in-memory origin AND no
    // record is still a real degradation.
    const messages: AttachableMessage[] = [
      { role: "assistant", uuid: "a-1", origin: { providerId: "openai", modelKey: "openai/o-test", family: "openai" } },
      { role: "assistant", uuid: "a-2" },
    ];
    const { warnings } = await attach({ messages, records: [], identity: { providerId: "openai", modelKey: "openai/o-test" } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.warning).toBe("provider_state_deleted");
    expect(String(warnings[0]!.detail)).toContain("1 resumed assistant message");
  });

  test("leg (a): an in-memory origin also suppresses the per-anchor `provider_state_missing` count", async () => {
    const messages: AttachableMessage[] = [
      { role: "assistant", uuid: "a-1", origin: { providerId: "openai", modelKey: "openai/o-test", family: "openai" } },
      { role: "assistant", uuid: "a-2" },
    ];
    const { warnings } = await attach({ messages, records: [record("a-3", "origin", {})] });
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]!.detail)).toContain("1 resumed assistant message");
  });
});
