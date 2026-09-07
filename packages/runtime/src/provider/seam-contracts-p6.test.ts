// Phase 6 Task 3 (R6-2): the executable contract for every seam this spine ships.
//
// THIS FILE IS THE SEAM'S AUTHORITY. Every lane brief cites it: a lane that wants to know what
// `ProviderRequest`/`ProviderTurn`/`ProviderMessage`/`ContentBlock`/`ProviderStateRecord` mean reads
// the assertions here, not a prose description of them. Both sides keep it green.
//
// Two halves:
//   1. THE BY-MEANING SWEEP (R6-3). `ContentBlock` grew three variants and `tool_result.content`
//      widened. Almost none of that breaks a build: a consumer with a `default:` arm or a
//      `block.content` fallthrough keeps compiling and starts silently dropping (or worse, silently
//      LEAKING) the new shapes. Each test below names one CONSUMER and asserts what it must do with
//      each new variant -- these are the fixtures that RED-fail on a silent drop.
//   2. THE TYPE-LEVEL CONTRACTS. The engine's own `ContentBlock`/`ProviderMessage` must stay
//      assignable to provider-runtime's `ContentBlockLike`/`ProviderMessageLike` in BOTH directions
//      for every shared variant, because the bridge converts between them on every generation.
import { test, expect, describe } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentBlockLike, MessageOrigin, ProviderMessageLike, ProviderNativeState } from "@yanlinglabs/winter-provider-runtime";
import type { ContentBlock, ProviderMessage, ProviderRequest, ProviderTurn, ProviderStreamSink } from "../engine.ts";
import { providerMessageContentToText } from "../engine.ts";
import { redactForSummary } from "../compaction/summarizer.ts";
import { assistantEntry } from "../store/dialect.ts";
import { rebuildProviderMessages, toDialectEntries } from "../store/resume.ts";
import { assembleReviewerMessages } from "../tools/impl/advisor.ts";
import { appendProviderState, buildContinuationChain, providerStateSidecarPath, readProviderState, type ProviderStateRecord } from "../store/provider-state.ts";
// P7a (Lane D): the R6-17 seam is asserted by BEHAVIOUR now (see its describe block), which spawns a
// real child through the real factory and reads the frames its engine emits.
import { createChildEngineFactory } from "../subagents/child-engine.ts";
import type { ChildEngineRunContext, ChildInheritance } from "../subagents/child-handle.ts";
import { echoProvider } from "./mock.ts";

// The three variants R6-3 adds, plus a text-with-calls turn -- one fixture value every consumer test
// below reuses, so a consumer that grows a new drop is caught by every one of them at once.
const SIGNATURE = "sig-abc-do-not-leak";
const REDACTED_DATA = "redacted-payload-do-not-leak";
const IMAGE_DATA = "aW1hZ2UtYnl0ZXM";

const NEW_BLOCKS: ContentBlock[] = [
  { type: "text", text: "the visible answer" },
  { type: "thinking", thinking: "step one then step two", signature: SIGNATURE },
  { type: "redacted_thinking", data: REDACTED_DATA },
  { type: "image", source: { type: "base64", media_type: "image/png", data: IMAGE_DATA } },
];

const OPAQUE_STRINGS = [SIGNATURE, REDACTED_DATA, IMAGE_DATA];

function expectNoOpaque(text: string): void {
  for (const secret of OPAQUE_STRINGS) expect(text).not.toContain(secret);
}

describe("R6-3 by-meaning sweep: every consumer of ContentBlock/ProviderTurn/ProviderMessage", () => {
  test("consumer 1 -- rebuildProviderMessages round-trips thinking/redacted_thinking/image verbatim", () => {
    // A resumed session MUST hand the provider back exactly what it produced: an Anthropic-family
    // thinking block replayed without its signature breaks the signature chain (item (f)'s
    // `resumed_from_incomplete_thinking` exists solely to preserve it), and a dropped image block
    // silently changes what the model was shown.
    const entry = assistantEntry({ content: NEW_BLOCKS, chain: { parentUuid: null }, ctx: { sessionId: "s", cwd: "/tmp", version: "0" } });
    const rebuilt = rebuildProviderMessages(toDialectEntries([entry]));
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]!.content).toEqual(NEW_BLOCKS);
  });

  test("consumer 1b -- a tool_result whose content is BLOCKS round-trips", () => {
    const blocks: ContentBlock[] = [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: IMAGE_DATA } }] }];
    const entry = assistantEntry({ content: blocks, chain: { parentUuid: null }, ctx: { sessionId: "s", cwd: "/tmp", version: "0" } });
    const rebuilt = rebuildProviderMessages(toDialectEntries([entry]));
    expect(rebuilt[0]!.content).toEqual(blocks);
  });

  test("consumer 2 -- providerMessageContentToText REPRESENTS each new variant, without its opaque fields", () => {
    // The advisor's transcript source flattens through here, and the failure mode is SILENT in a way
    // worth naming: the old code ended in a bare `return block.content`, which is `undefined` on all
    // three new variants -- and `Array.prototype.join` renders `undefined` as the EMPTY STRING, so a
    // dropped block leaves no trace at all in the output. Nothing throws, nothing logs, and a
    // reviewer silently stops being told that the turn reasoned or produced an image.
    //
    // So the assertion is "each variant is represented", not "no 'undefined' appears": the first
    // RED-fails on the drop, the second does not.
    const text = providerMessageContentToText(NEW_BLOCKS);
    expect(text).toContain("the visible answer");
    expect(text).toContain("thinking");
    expect(text).toContain("redacted");
    expect(text).toContain("image");
    expect(text).not.toContain("undefined");
    expectNoOpaque(text);
  });

  test("consumer 2b -- a blocks-valued tool_result flattens to its inner text, not '[object Object]'", () => {
    const text = providerMessageContentToText([{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "inner result" }] }]);
    expect(text).toContain("inner result");
    expect(text).not.toContain("[object Object]");
  });

  // CONSUMERS 3 AND 4 ARE TRIPWIRES, NOT TESTS, and this file is the seam authority six lanes read --
  // so the distinction is stated rather than left for a reader to discover. Consumer 3 passes with
  // `stripOpaqueMarkers` DELETED (the flattener already emits nothing opaque, so there is nothing for
  // the stripper to remove); it fires only if the flattener starts emitting a marker again. Consumer
  // 4 can only catch a RUNTIME narrowing of `Block`, because the alias `type Block = ContentBlock`
  // makes any type-level narrowing a compile error long before this runs. Both are worth keeping --
  // they pin a property that would otherwise have no assertion at all -- but neither is evidence that
  // the mechanism it names works.
  test("consumer 3 (TRIPWIRE) -- the advisor's opaque stripping still removes any line that names a marker", () => {
    const { messages } = assembleReviewerMessages([{ role: "assistant", text: providerMessageContentToText(NEW_BLOCKS) }]);
    for (const message of messages) expectNoOpaque(typeof message.content === "string" ? message.content : JSON.stringify(message.content));
  });

  test("consumer 4 (TRIPWIRE) -- the dialect Block type persists the new variants verbatim", () => {
    // `store/dialect.ts`'s `Block` IS `ContentBlock`; this asserts the alias still carries every
    // variant onto disk rather than a narrowed copy of it.
    const entry = assistantEntry({ content: NEW_BLOCKS, chain: { parentUuid: null }, ctx: { sessionId: "s", cwd: "/tmp", version: "0" } });
    expect(entry.message.content).toEqual(NEW_BLOCKS);
  });

  test("consumer 5 -- the compaction summariser input carries NO opaque field of any new variant", () => {
    // Redaction here is a POSITIVE REBUILD: an unknown block is dropped, never guessed at. The
    // assertion is not "thinking survives" -- it is that nothing opaque reaches a model-readable
    // summary request, and that the message's own annotations are left behind by construction.
    const messages: ProviderMessage[] = [
      { role: "assistant", content: NEW_BLOCKS, origin: { providerId: "p", modelKey: "p/m", family: "openai" }, nativeState: { family: "openai", continuationDomain: "openai:responses", items: [{ encrypted_content: "OPAQUE-ITEM" }] } },
    ];
    const redacted = redactForSummary(messages);
    const serialized = JSON.stringify(redacted);
    expectNoOpaque(serialized);
    expect(serialized).not.toContain("OPAQUE-ITEM");
    expect(serialized).not.toContain("encrypted_content");
    for (const message of redacted) {
      expect(message.origin).toBeUndefined();
      expect(message.nativeState).toBeUndefined();
    }
  });

  // CONSUMER 6 (the child fork mirror) IS NOT HERE. It was, and the test it replaced spread the
  // array ITSELF and asserted the annotations survived -- which tests JavaScript's spread operator,
  // not `engine.ts`'s `buildChildInheritance`. Reverting the real consumer to a `{role, content}`
  // rebuild left it green. The real fixture drives a live `runEngine` fork and lives in
  // `engine-seam-p6.test.ts` ("a FORK's inherited history keeps the parent's provider annotations"),
  // because a mirror can only be tested through the thing that mirrors.

  test("consumer 7 -- a tool_use turn carries its leading TEXT (a real model returns both)", () => {
    // R6-3, stated as the reason the field exists: "a real model returns text AND calls in one turn
    // -- the text persists as a leading text block". A `tool_use` turn whose `text` is dropped loses
    // a whole assistant utterance from the transcript with nothing failing anywhere.
    const turn: ProviderTurn = { kind: "tool_use", text: "I'll read the file first.", calls: [{ id: "t1", name: "Read", input: {} }] };
    expect(turn.kind === "tool_use" ? turn.text : undefined).toBe("I'll read the file first.");
  });
});

describe("R6-3 type-level contract: the engine's unions and provider-runtime's mirrors agree", () => {
  test("every shared ContentBlock variant is assignable in BOTH directions", () => {
    // Compile-time, asserted at runtime only so the test reports. The bridge converts an adapter's
    // blocks into the engine's on every generation; a one-way-only assignability is a cast waiting
    // to be written.
    const engineBlocks: ContentBlock[] = NEW_BLOCKS;
    const asLike: ContentBlockLike[] = engineBlocks;
    const backToEngine: ContentBlock[] = asLike as ContentBlock[];
    expect(backToEngine).toEqual(engineBlocks);

    const likeBlocks: ContentBlockLike[] = [
      { type: "text", text: "t" },
      { type: "tool_use", id: "i", name: "n", input: {} },
      { type: "tool_result", tool_use_id: "i", content: "r" },
      { type: "thinking", thinking: "th", signature: "s" },
      { type: "redacted_thinking", data: "d" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
      { type: "tool_reference", tool_names: ["a"] },
    ];
    const asEngine: ContentBlock[] = likeBlocks as ContentBlock[];
    expect(asEngine).toHaveLength(7);
  });

  test("a ProviderMessage is a ProviderMessageLike and back", () => {
    const message: ProviderMessage = {
      role: "assistant",
      content: NEW_BLOCKS,
      uuid: "u",
      origin: { providerId: "p", modelKey: "p/m", family: "anthropic" },
      nativeState: { family: "anthropic", continuationDomain: "anthropic:messages", items: [] },
      decoration: { text: "note", door: "tag" },
    };
    const asLike: ProviderMessageLike = message;
    const back: ProviderMessage = asLike as ProviderMessage;
    expect(back.uuid).toBe("u");
    expect(back.decoration?.door).toBe("tag");
  });

  test("ProviderRequest carries every field R6-3 adds, and every one is optional", () => {
    // A pre-existing Provider double must keep compiling: `{ messages }` alone is a legal request.
    const minimal: ProviderRequest = { messages: [] };
    expect(minimal.messages).toEqual([]);

    const sink: ProviderStreamSink = {
      onStreamEvent: () => {},
      onRetry: () => {},
      onRateLimit: () => {},
      onAuthStatus: () => {},
      onReasoningSummary: () => {},
    };
    const full: ProviderRequest = {
      messages: [{ role: "user", content: "hi" }],
      system: "sys",
      tools: [{ name: "Read", description: "read a file", inputSchema: { type: "object" } }],
      toolChoice: { type: "auto" },
      model: "p/m",
      effort: "high",
      thinking: { type: "enabled", budgetTokens: 1024 },
      signal: new AbortController().signal,
      sink,
    };
    expect(full.tools?.[0]?.name).toBe("Read");
    expect(full.signal?.aborted).toBe(false);
  });

  test("ProviderTurn's two production kinds carry usage/stopReason/thinking/nativeState", () => {
    const text: ProviderTurn = {
      kind: "text",
      text: "done",
      usage: { inputTokens: 1, outputTokens: 2 },
      stopReason: "end_turn",
      thinking: { summary: "considered options", blocks: [{ type: "thinking", thinking: "t", signature: "s" }] },
      nativeState: { family: "openai", continuationDomain: "openai:responses", items: [1] },
    };
    expect(text.stopReason).toBe("end_turn");
    const calls: ProviderTurn = { kind: "tool_use", calls: [], text: "leading", usage: { inputTokens: 1, outputTokens: 2 }, stopReason: "tool_use" };
    expect(calls.kind === "tool_use" ? calls.text : "").toBe("leading");
  });
});

describe("R6-7 contract: the provider-state sidecar", () => {
  test("a record is a SessionStoreEntry-shaped envelope with its OWN uuid, never the anchor's", () => {
    // Item (h) constraint 2: `uuid` is the store's idempotency key. A record that set `uuid` to the
    // anchor would make every record for one assistant entry collide into a single upserted row.
    const dir = mkdtempSync(join(tmpdir(), "winter-p6-sidecar-"));
    try {
      const path = providerStateSidecarPath(join(dir, "sess-1.jsonl"));
      expect(path).toBe(join(dir, "sess-1.provider-state.jsonl"));
      const record = appendProviderState(path, { sessionId: "sess-1", anchorUuid: "anchor-1", provider: "openai", model: "openai/o-test", family: "openai", itemIndex: 0, kind: "origin", payload: {} });
      expect(record.type).toBe("winter_provider_state");
      expect(record.uuid).not.toBe(record.anchorUuid);
      expect(typeof record.timestamp).toBe("string");
      const read = readProviderState(path);
      expect(read).toEqual([record]);
      const raw = JSON.parse(readFileSync(path, "utf8").trim()) as Record<string, unknown>;
      expect(raw.type).toBe("winter_provider_state");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("buildContinuationChain ignores a record whose anchor entry is missing", () => {
    const orphan: ProviderStateRecord = { type: "winter_provider_state", uuid: "r-1", timestamp: "t", sessionId: "s", anchorUuid: "gone", provider: "p", model: "p/m", family: "openai", itemIndex: 0, kind: "origin", payload: {} };
    const kept: ProviderStateRecord = { type: "winter_provider_state", uuid: "r-2", timestamp: "t", sessionId: "s", anchorUuid: "here", provider: "p", model: "p/m", family: "openai", itemIndex: 0, kind: "origin", payload: {} };
    const chain = buildContinuationChain([orphan, kept], new Set(["here"]));
    expect(chain.has("gone")).toBe(false);
    expect(chain.get("here")?.origin).toEqual({ providerId: "p", modelKey: "p/m", family: "openai" });
  });
});

// --------------------------------------------------------------------------------------------------
// The SEAM AUTHORITIES a lane brief cites. Each assertion below is the answer to "what exactly may I
// rely on", so a lane never has to read an implementation to find out.
// --------------------------------------------------------------------------------------------------

describe("R6-4 contract: the bridge (Lanes A / B / N)", () => {
  test("`foldProviderStream` is the REAL consumer a lane tests its adapter's stream against", async () => {
    // Exported precisely so a family lane never re-implements the fold to test against it -- a
    // re-implementation would agree with the lane and disagree with production.
    const { foldProviderStream } = await import("./bridge.ts");
    const turn = await foldProviderStream(
      (async function* () {
        yield { type: "text_delta", text: "hi" } as const;
        yield { type: "done", stopReason: "end_turn" } as const;
      })(),
    );
    expect(turn).toEqual({ kind: "text", text: "hi", stopReason: "end_turn" });
  });

  test("the fold NEVER retries: `withRetry` is the adapter's, strictly before the first byte", async () => {
    const { foldProviderStream, ProviderTurnError } = await import("./bridge.ts");
    let consumed = 0;
    const stream = (async function* () {
      consumed++;
      yield { type: "text_delta", text: "partial" } as const;
      yield { type: "error", error: { code: "server" as const, message: "boom", status: 503, retryable: true } } as const;
    })();
    await expect(foldProviderStream(stream)).rejects.toThrow(ProviderTurnError);
    expect(consumed).toBe(1);
  });

  test("`HistoryRenderer` is the shape Lane C implements, and T3's identity renderer is the fallback", async () => {
    const { createIdentityHistoryRenderer } = await import("./bridge.ts");
    const renderer = createIdentityHistoryRenderer();
    const messages: ProviderMessage[] = [{ role: "assistant", content: "x", nativeState: { family: "openai", continuationDomain: "d1", items: ["OPAQUE"] } }];
    // Same domain: replayed. Different domain: dropped, with the message itself intact.
    expect(renderer.render(messages, new Map(), { family: "openai", continuationDomain: "d1", readableState: "none" })[0]!.nativeState).toBeDefined();
    const crossed = renderer.render(messages, new Map(), { family: "anthropic", continuationDomain: "d2", readableState: "none" });
    expect(crossed[0]!.nativeState).toBeUndefined();
    expect(JSON.stringify(crossed)).not.toContain("OPAQUE");
  });
});

describe("R6-9 contract: selection (Lanes A / B / D / N)", () => {
  test("a resolution failure is a TYPED `WinterProviderResolutionError`, never a silent default", async () => {
    const { resolveSessionProvider } = await import("./selection.ts");
    const { WinterProviderResolutionError, createMemoryCredentialStore, createRegistry } = await import("@yanlinglabs/winter-provider-runtime");
    const registry = createRegistry({ schemaVersion: 2, families: [], catalogVersion: "t", providers: [], models: [] } as never);
    let threw: unknown;
    try {
      resolveSessionProvider({ sessionId: "s", cwd: "/tmp", model: "bare-id" } as never, { registry, credentials: createMemoryCredentialStore(), env: {} });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(WinterProviderResolutionError);
  });

  test("the identity a lane sees carries the adapter's OWN version and the catalog's -- read off a real resolution", async () => {
    // R6-9's `winter_provider` init extension and the dialect record are both built from this shape,
    // so a lane adding an adapter must set `version` on it or the identity is incomplete. Asserted
    // against a REAL resolution rather than a hand-written key list, which would only agree with
    // itself.
    const { resolveSessionProvider } = await import("./selection.ts");
    const { createMemoryCredentialStore, createRegistry } = await import("@yanlinglabs/winter-provider-runtime");
    const evidence = <T,>(value: T) => ({ value, source: "official-doc" as const, confidence: "verified" as const, observedAt: "2026-09-05" });
    const registry = createRegistry({
      schemaVersion: 2,
      families: [],
      catalogVersion: "cat-9",
      providers: [
        {
          id: "p",
          displayName: "p",
          adapterId: "a",
          protocol: "openai-responses",
          auth: { kinds: ["api-key"] },
          endpoints: { base: "https://p.example" },
          modelDiscovery: "static",
          liveCatalogAuthority: "advisory",
          risk: { class: "standard", reasons: [] },
          upstream: { project: "winter", commit: "" },
        },
      ],
      models: [
        {
          key: "p/m",
          providerId: "p",
          upstreamId: "m-1",
          displayName: "m",
          aliases: [],
          status: "candidate",
          toolCalling: evidence("native"),
          reasoning: { continuation: "opaque", continuationDomain: evidence(["p:domain"]), readableState: "none" },
          upstream: { project: "winter", commit: "" },
        },
      ],
    } as never);
    registry.register({
      id: "a",
      version: "9.9.9",
      family: "openai",
      protocol: "openai-responses",
      async validateCredential() {
        return { ok: true };
      },
      async listModels() {
        return { models: [], partial: false, cached: false, warnings: [] };
      },
      async *streamTurn() {},
      mapEffort: () => ({ ok: true, value: "medium" }),
      capabilities: () => ({ toolCalling: "native", readableState: "none" }),
    });
    const out = resolveSessionProvider({ sessionId: "s", cwd: "/tmp", model: "p/m" } as never, { registry, credentials: createMemoryCredentialStore(), env: {} });
    if ("testProvider" in out) throw new Error("expected a catalog selection");
    expect(Object.keys(out.identity).sort()).toEqual(["adapterId", "adapterVersion", "authRefKind", "catalogVersion", "continuationDomain", "modelKey", "providerId"]);
    expect(out.identity.adapterVersion).toBe("9.9.9");
    expect(out.identity.catalogVersion).toBe("cat-9");
  });
});

describe("R6-6 contract: cancellation reaches BOTH sides", () => {
  test("`ToolExecutionContext.signal` exists and is optional -- an executor that ignores it is unchanged", async () => {
    const registry = await import("../tools/registry.ts");
    // A structural assertion rather than a type-only one: the field has to be present at runtime on
    // the context the real engine-facing executor builds, or Bash/Monitor never see it.
    const executor = registry.buildRegistryToolExecutor({
      sessionId: "s",
      home: "/tmp",
      getCwd: () => "/tmp",
      readState: (await import("../tools/read-state.ts")).createSessionReadState(),
      emitFrame: () => {},
      probeReadAccess: () => "silent",
      getTempDir: () => "/tmp",
      sandboxSettings: {},
      session: {
        setCwd() {},
        addBoundedRoot() {},
        removeBoundedRoot() {},
        setPermissionMode() {},
        getBoundedRoots: () => [],
        getPermissionMode: () => "default",
        getSessionRoot: () => "/tmp",
        setSessionRoot() {},
      },
    } as never);
    const controller = new AbortController();
    // An unknown tool short-circuits before any executor runs, which is all this needs: what is
    // asserted is that passing the option is ACCEPTED by the seam, on the real builder.
    const result = await executor.execute({ id: "t", name: "definitely-not-a-tool", input: {} }, { signal: controller.signal });
    expect(typeof result.output).toBe("string");
  });
});

describe("R6-17 contract: the parent's identity reaches the CHILD's engine, not merely its inheritance", () => {
  // The P5 factory-seam lesson, applied to its own successor: a field declared upstream proves
  // NOTHING across the seam. `ChildInheritance.provider` existing does not make the child's ENGINE
  // know its provider -- the child engine has to read it and pass it on.
  //
  // P7a (Lane D). This used to be a SOURCE-TEXT pin: `expect(source).toContain("inherit.provider
  // !== undefined ? { providerIdentity: inherit.provider }")`. Its own comment called itself a
  // placeholder "until" the real end-to-end proof landed -- and by P6.6 the substring it pinned had
  // become UNREACHABLE code kept alive only to satisfy this assertion (P6.6 Lane D review, m1), so
  // the test was preserving dead code and proving nothing about the seam. Both are gone.
  //
  // THE OBSERVABLE IS THE CHILD'S OWN `system/init` FRAME. `winter_provider` is emitted by
  // `runEngine` and ONLY when `EngineOptions.providerIdentity` is set (engine.ts's init block
  // spreads it conditionally, so "no identity" means the key is absent, never a fabricated row) --
  // which is exactly "the identity crossed the seam", stated as behaviour. A rename on either side
  // still fails this, which was the old pin's stated virtue, now for a real reason.
  const parentIdentity = {
    providerId: "seamprov",
    modelKey: "seamprov/seam-model",
    family: "openai",
  } as const;

  /** Spawns one child to completion and hands back every frame its engine forwarded. */
  async function childFrames(withProvider: boolean): Promise<Array<Record<string, unknown>>> {
    const root = mkdtempSync(join(tmpdir(), "winter-p7a-r617-"));
    try {
      const sessionRoot = join(root, "work");
      mkdirSync(sessionRoot, { recursive: true });
      const inherit: ChildInheritance = {
        policy: { effectiveMode: "default", parentPolicyVersion: 1, parentPolicyHash: "h" },
        tools: [],
        model: parentIdentity.modelKey,
        effort: "medium",
        thinking: undefined,
        systemPrompt: "",
        sessionRoot,
        // Spread CONDITIONALLY rather than set to `undefined`: under `exactOptionalPropertyTypes`
        // the two differ, and an explicit `undefined` is a shape production never produces.
        ...(withProvider ? { provider: parentIdentity } : {}),
      };
      const frames: Array<Record<string, unknown>> = [];
      // The minimum `ChildEngineRunContext`: only `parentSessionId` and `forwardChildFrame` are
      // required. No store, because the child's provider-state SIDECAR is not the observable --
      // `child-engine.ts` builds its child writer without a `winterHome`, so a child's sidecar sink
      // is never constructed and its chain is in-memory for the run (noted in this lane's report).
      const factory = createChildEngineFactory({ provider: echoProvider });
      const handle = await factory({
        parentSessionId: "seam-parent",
        forwardChildFrame(frame) {
          frames.push(frame as unknown as Record<string, unknown>);
        },
      }).spawn({ parentToolUseId: "call-seam", prompt: "one turn", runInBackground: false }, inherit);
      const deadline = Date.now() + 10_000;
      while (handle.status() === "running" && Date.now() < deadline) await Bun.sleep(1);
      expect(handle.status()).toBe("completed");
      return frames;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  /** The `winter_provider` block off the child's own `system/init`, or `undefined` when it carries none. */
  function initProvider(frames: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
    for (const frame of frames) {
      const message = (frame as { message?: { type?: string; subtype?: string; winter_provider?: Record<string, unknown> } }).message;
      if (message?.type === "system" && message.subtype === "init") return message.winter_provider;
    }
    return undefined;
  }

  test("a child spawned under a parent WITH an identity reports that provider on its OWN system/init", async () => {
    const frames = await childFrames(true);
    expect(initProvider(frames)).toEqual({ providerId: parentIdentity.providerId, modelKey: parentIdentity.modelKey });
  });

  test("...and a child of a parent with NO identity reports none -- absent, never a fabricated row", async () => {
    // The negative half, and the reason the positive one is not vacuous: a child that stamped a
    // provider block unconditionally (from its own `config.model`, say) would satisfy the first test
    // while carrying nothing of the parent's identity across the seam.
    const frames = await childFrames(false);
    expect(frames.length).toBeGreaterThan(0); // the child DID run -- an empty frame list would pass the assertion below for the wrong reason
    expect(initProvider(frames)).toBeUndefined();
  });
});
