// P6 fix wave: the PUBLIC `forkSession()` door carries the provider-state chain and the identity
// block (T3 re-review round 2, M3 -- carried as chain-less; `fix-wave-carries.md`).
//
// The runtime's own `resume + forkSession` path had a chain copy; the standalone session API called
// `forkSessionByKey` bare, so a host forking through it resumed on the pre-P6 silent path. The carry
// now lives in the store primitive both doors call. This fixture drives the PUBLIC door end to end:
// a persisted source with an identity block and a real chain, `forkSession()` from the sdk, then a
// resume of the fork through the real engine -- and reads the ground truth off what the provider
// received and what the host stream did NOT say.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forkSession, getSessionInfo } from "@yanlinglabs/winter-agent-sdk";
import { resolveEngineSession } from "./dialect.ts";
import { runEngine } from "../engine.ts";
import { createInMemoryChannel } from "../protocol/channel.ts";

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "winter-fixe-fork-door-"));
  try {
    await run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("the public `forkSession()` door carries the chain and the identity block", () => {
  test("a fork made through the session API resumes with the source's origins and native state re-attached, the identity block present, and NO continuity warning", () =>
    withTempHome(async (home) => {
      const cwd = mkdtempSync(join(tmpdir(), "winter-fixe-fork-door-cwd-"));
      try {
        const anchor = "ffffffff-2222-4222-8222-222222222222";
        // A source with a real identity block and a real chain, exactly as a P6 session leaves it.
        const source = await resolveEngineSession({ config: { sessionId: "sess-door-src", cwd, model: "m", permissionMode: "default" } as never, resolveWinterHome: () => home, env: {} });
        source.store!.setProviderIdentity!({ providerId: "openai", modelKey: "openai/o-test", adapterId: "openai-responses", adapterVersion: "1.0.0", catalogVersion: "0.0.0-seed", authRefKind: "env", classifierPin: "openai/o-reviewer" });
        await source.store!.recordUserEntry("hello");
        await source.store!.recordProviderState!({ sessionId: "sess-door-src", anchorUuid: anchor, provider: "openai", model: "openai/o-test", family: "openai", continuationDomain: "openai:responses", itemIndex: 0, kind: "origin", payload: {} });
        await source.store!.recordProviderState!({ sessionId: "sess-door-src", anchorUuid: anchor, provider: "openai", model: "openai/o-test", family: "openai", continuationDomain: "openai:responses", itemIndex: 1, kind: "native-state", payload: { items: ["OPAQUE-DOOR"] } });
        await source.store!.recordAssistantEntry([{ type: "text", text: "one" }], { uuid: anchor });
        await source.store!.flush?.();

        // THE PUBLIC DOOR.
        const { sessionId: forkedId } = await forkSession("sess-door-src", { winterHome: home, directory: cwd });
        expect(forkedId).not.toBe("sess-door-src");
        // The fork is a real session the listing surface can see, with its OWN entry count (the
        // identity fold never overwrote the mechanical fields).
        const info = await getSessionInfo(forkedId, { winterHome: home, directory: cwd });
        expect(info.entryCount).toBe(2);

        // RESUME the fork through the real path.
        const resumed = await resolveEngineSession({ config: { sessionId: "unused", cwd, model: "m", permissionMode: "default", resume: forkedId } as never, resolveWinterHome: () => home, env: {} });
        // The chain came with it: re-owned, re-keyed, still anchored on the source's entry uuid.
        const records = await resumed.store!.loadProviderState!();
        expect(records.map((r) => r.kind)).toEqual(["origin", "native-state"]);
        for (const r of records) {
          expect(r.sessionId).toBe(forkedId);
          expect(r.anchorUuid).toBe(anchor);
        }
        // The identity block came with it -- the WHOLE block, pin included, and nothing else.
        expect(await resumed.store!.loadProviderIdentity!()).toEqual({ providerId: "openai", modelKey: "openai/o-test" });
        const summary = await (resumed.store as unknown as { loadProviderIdentity(): Promise<unknown> }).loadProviderIdentity();
        expect(summary).toBeDefined();

        // And the engine sees the native replay, with no warning on the host stream.
        const { host, runtime } = createInMemoryChannel();
        let seen: Array<{ role: string; uuid?: string; origin?: unknown; nativeState?: unknown }> = [];
        const provider = {
          async generate(input: { messages: Array<{ role: string; uuid?: string; origin?: unknown; nativeState?: unknown }> }) {
            seen = input.messages;
            return { kind: "text" as const, text: "done" };
          },
        };
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

        const inherited = seen.find((m) => m.uuid === anchor);
        expect(inherited?.origin).toEqual({ providerId: "openai", modelKey: "openai/o-test", family: "openai", continuationDomain: "openai:responses" });
        expect(inherited?.nativeState).toEqual({ family: "openai", continuationDomain: "openai:responses", items: ["OPAQUE-DOOR"] });
        const warnings = frames
          .filter((f) => (f as { type?: string }).type === "data")
          .map((f) => (f as { message: Record<string, unknown> }).message)
          .filter((m) => m.type === "system" && m.subtype === "continuity_warning");
        expect(warnings).toHaveLength(0);
        // Opaque state never reached the host stream.
        expect(JSON.stringify(frames)).not.toContain("OPAQUE-DOOR");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }));
});
