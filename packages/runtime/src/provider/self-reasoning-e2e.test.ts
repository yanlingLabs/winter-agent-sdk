// E1 (dist-session fixes, 2026-09-22): a MULTI-STEP turn on `deepseek-anthropic/deepseek-v4-flash`,
// driven through the REAL engine, the REAL session-provider wiring, the REAL bridge and the REAL
// Anthropic adapter against a loopback -- and the ground truth read off what the endpoint received.
//
// What the installed app did (s_5d314c81045e, generation 1, never resumed, never handed off): the
// model's own step-1 thinking came back to it on step 2 as a `<recovered_reasoning kind="summary"
// provider="deepseek-anthropic" …>` TEXT block inside its own assistant turn, and the model imitated
// the tag in its visible reply. The row declares `continuation: "none"`, so it has no continuation
// domain, and the renderer used to classify the model's own previous step as foreign. The unit half
// of the proof is provider-runtime's `continuity/self-reasoning-real-catalog.test.ts`; this file is
// the half no unit test can give: the request a real session actually sends.
//
// Parity target: claude sends its own thinking blocks back to the model that produced them, in-dialect
// with the signature the endpoint sent, and never quotes a model's reasoning back to it as text.
import { describe, expect, test } from "bun:test";
import { serve } from "bun";
import type { RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { loadCatalog, type WinterCatalog } from "@yanlinglabs/winter-provider-catalog";
import { RECOVERED_REASONING_TAG, createMemoryCredentialStore } from "@yanlinglabs/winter-provider-runtime";
import { runEngine } from "../engine.ts";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { stubExecutor } from "./mock.ts";
import { buildSessionProvider } from "./session-provider.ts";

const MODEL = "deepseek-anthropic/deepseek-v4-flash";
const PROVIDER = "deepseek-anthropic";
const OWN_THINKING = "step-1 reasoning of my own: list the directory before answering";
const OWN_SIGNATURE = "sig-deepseek-step-1";

/** A loopback Anthropic-dialect endpoint: step 1 thinks and calls Glob, step 2 thinks and answers. Keyed on the BODY (a tool result present = step 2). */
async function startDeepseekAnthropicFake(): Promise<{ url: string; bodies: string[]; close(): Promise<void> }> {
  const bodies: string[] = [];
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.text();
      if (!url.pathname.endsWith("/v1/messages")) return new Response("no route", { status: 404 });
      bodies.push(body);
      const step2 = body.includes("tool_result");
      const frames: Array<[string, unknown]> = [
        ["message_start", { type: "message_start", message: { id: `msg_${bodies.length}`, type: "message", role: "assistant", model: "deepseek-v4-flash", content: [], usage: { input_tokens: 9, output_tokens: 1 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: step2 ? "the listing is back; answer" : OWN_THINKING } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: step2 ? "sig-step-2" : OWN_SIGNATURE } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ];
      if (!step2) {
        frames.push(
          ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_e1", name: "Glob", input: {} } }],
          ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify({ pattern: "*.winter-e1-none" }) } }],
          ["content_block_stop", { type: "content_block_stop", index: 1 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } }],
        );
      } else {
        frames.push(
          ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "The directory is empty." } }],
          ["content_block_stop", { type: "content_block_stop", index: 1 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 6 } }],
        );
      }
      frames.push(["message_stop", { type: "message_stop" }]);
      const text = frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
      return new Response(text, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, bodies, close: async () => void (await server.stop(true)) };
}

/** The REAL catalog with ONE change: the provider's reviewed endpoint points at the loopback. The model row is untouched. */
function catalogAt(url: string): WinterCatalog {
  const catalog = loadCatalog();
  return { ...catalog, providers: catalog.providers.map((p) => (p.id === PROVIDER ? { ...p, defaultEndpoints: { ...p.defaultEndpoints, api: url } } : p)) };
}

async function drain(source: AsyncIterable<WinterFrame>): Promise<WinterFrame[]> {
  const out: WinterFrame[] = [];
  for await (const f of source) out.push(f);
  return out;
}

describe("E1: a deepseek-anthropic session's own reasoning replays natively on its next step", () => {
  test("step 2's request carries step 1's thinking block in-dialect, with its signature, and NO <recovered_reasoning> text", async () => {
    const fake = await startDeepseekAnthropicFake();
    try {
      const catalog = catalogAt(fake.url);
      const row = catalog.models.find((m) => m.key === MODEL);
      // The fact the bug hinged on, asserted so a future catalog change cannot silently turn this into a test of something else.
      expect(row?.reasoning?.continuation).toBe("none");

      const config = {
        sessionId: "e1",
        cwd: "/tmp/x",
        model: MODEL,
        persistSession: false,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        provider: { providerId: PROVIDER, authRef: { kind: "inline", value: "test-key-e1" } },
      } as RuntimeConfig;
      const wiring = buildSessionProvider({ config, env: {}, catalog, credentials: createMemoryCredentialStore() });
      const identity = wiring.identity!;
      const { host, runtime } = createInMemoryChannel();
      const done = runEngine({
        config,
        input: runtime.input,
        output: runtime.output,
        provider: wiring.provider,
        tools: stubExecutor,
        // EXACTLY what `production-wiring.ts` hands the engine.
        providerIdentity: {
          providerId: identity.providerId,
          modelKey: identity.modelKey,
          family: String(wiring.resolved?.adapter.family ?? ""),
          ...(identity.continuationDomain !== undefined ? { continuationDomain: identity.continuationDomain } : {}),
          adapterId: identity.adapterId,
          adapterVersion: identity.adapterVersion,
          catalogVersion: identity.catalogVersion,
          authRefKind: identity.authRefKind,
        },
      });
      host.output.write({ type: "user", text: "what is in this directory?" });
      host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
      await drain(host.input);
      await done;

      expect(fake.bodies).toHaveLength(2);
      const step2 = JSON.parse(fake.bodies[1]!) as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
      const ownTurn = step2.messages.find((m) => m.role === "assistant" && m.content.some((b) => b["type"] === "tool_use"));
      expect(ownTurn).toBeDefined();
      // Native, in-dialect, leading, with the endpoint's own signature -- what claude sends back.
      expect(ownTurn!.content[0]).toEqual({ type: "thinking", thinking: OWN_THINKING, signature: OWN_SIGNATURE });
      // And nowhere in the request is the model's reasoning quoted back to it as text.
      expect(fake.bodies[1]).not.toContain(RECOVERED_REASONING_TAG);
      const texts = step2.messages.flatMap((m) => m.content.filter((b) => b["type"] === "text").map((b) => String(b["text"])));
      for (const text of texts) expect(text).not.toContain(OWN_THINKING);
    } finally {
      await fake.close();
    }
  });
});
