// WS-25 §7 (prompt-free credentials): a host-brokered session resolves its Keychain credentials over the
// control channel -- never the Keychain -- persists nothing, holds no refresh token, and the material
// appears NOWHERE but the one control_response frame and the provider request that needs it.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type ControlRequestFrame, type CredentialResolveAnswer, type CredentialResolveRequest, type WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createCompositeCredentialStore, refreshOauthMaterial } from "@yanlinglabs/winter-provider-runtime";
import { inMemoryProcess } from "../testing.ts";
import { echoProvider } from "./mock.ts";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine } from "../engine.ts";
import { getRegisteredTool, replaceExecutor } from "../tools/registry.ts";
import { ADVISOR_TOOL_NAME } from "../tools/impl/advisor.ts";
import { createHostBrokeredCredentialStore, createHostBrokeredSecretReader, createHostCredentialChannel, type HostRequestSender } from "./host-credentials.ts";

const SECRET = "sk-host-brokered-SECRET-4242";

/** A host double answering `credential_resolve` from a map, recording every request. */
function fakeHost(items: Record<string, { material: string; generation: number }>): HostRequestSender & { asks: CredentialResolveRequest[] } {
  const asks: CredentialResolveRequest[] = [];
  return {
    asks,
    async request<T>(subtype: string, payload: unknown): Promise<T> {
      expect(subtype).toBe("credential_resolve");
      const req = payload as CredentialResolveRequest;
      asks.push(req);
      const item = items[req.ref.account];
      if (item === undefined) return { ok: false, reason: "not_found" } as T;
      if (req.minGeneration !== undefined && item.generation < req.minGeneration) return { ok: false, reason: "stale" } as T;
      return { ok: true, material: item.material, generation: item.generation } as T;
    },
  };
}

describe("the host-brokered credential store", () => {
  test("get resolves through the host, strips any refresh token, and never writes", async () => {
    const host = fakeHost({ "codex-oauth:default": { material: JSON.stringify({ kind: "oauth", accessToken: "at-1", refreshToken: "rt-NEVER", expiresAt: 5 }), generation: 3 } });
    const store = createHostBrokeredCredentialStore(host);
    const ref = { kind: "keychain" as const, account: "codex-oauth:default" };
    expect(await store.get(ref)).toEqual({ kind: "oauth", accessToken: "at-1", expiresAt: 5 });
    await expect(store.set(ref, { kind: "api-key", key: "x" })).rejects.toMatchObject({ code: "unsupported" });
    await expect(store.delete(ref)).rejects.toMatchObject({ code: "unsupported" });
    expect(await store.get({ kind: "keychain", account: "nothing:here" })).toBeNull();
    await expect(store.get({ kind: "env", name: "X" })).rejects.toMatchObject({ code: "unsupported" }); // the composite asks the next member
  });

  test("renewal is ASKED of the host with minGeneration -- refreshOauthMaterial posts no grant and writes nothing", async () => {
    const items = { "codex-oauth:default": { material: JSON.stringify({ kind: "oauth", accessToken: "at-1" }), generation: 3 } };
    const host = fakeHost(items);
    const store = createHostBrokeredCredentialStore(host);
    const ref = { kind: "keychain" as const, account: "codex-oauth:default" };
    await store.get(ref);
    items["codex-oauth:default"] = { material: JSON.stringify({ kind: "oauth", accessToken: "at-2", refreshToken: "rt-NEVER" }), generation: 4 };
    // tokenUrl is unreachable on purpose: a posted grant would fail loudly.
    const renewed = await refreshOauthMaterial({ store, ref, tokenUrl: "https://auth.invalid/oauth/token", clientId: "c" });
    expect(renewed).toEqual({ kind: "oauth", accessToken: "at-2" });
    expect(host.asks.map((a) => a.minGeneration)).toEqual([undefined, 4]);
    // A host that cannot produce a newer generation says `stale`: a typed error naming the ref only.
    const err = await store.refresh(ref).catch((e: unknown) => e);
    expect((err as Error).message).toContain("codex-oauth:default");
    expect((err as Error).message).toContain("stale");
    expect((err as Error).message).not.toContain("at-2");
  });

  test("M-b: the composite routes ONLY keychain refs to the host renewer", async () => {
    const composite = createCompositeCredentialStore([createHostBrokeredCredentialStore(fakeHost({}))]);
    await expect(composite.refresh!({ kind: "env", name: "X" } as never)).rejects.toMatchObject({ code: "unsupported" });
  });

  test("the tool-secret reader returns the item's string; a refusal never quotes the host", async () => {
    const reader = createHostBrokeredSecretReader(fakeHost({ "exa:default": { material: "exa-raw-key", generation: 1 } }));
    expect(await reader({ kind: "keychain", account: "exa:default" })).toBe("exa-raw-key");
    expect(await reader({ kind: "keychain", account: "missing" })).toBeNull();
  });

  test("the channel waits for the engine to bind it, and fails typed when it never does", async () => {
    const channel = createHostCredentialChannel({ bindTimeoutMs: 50 });
    const pending = createHostBrokeredSecretReader(channel)({ kind: "keychain", account: "exa:default" });
    channel.bind(fakeHost({ "exa:default": { material: "late-bound", generation: 1 } }));
    expect(await pending).toBe("late-bound");
    const never = createHostCredentialChannel({ bindTimeoutMs: 30 });
    await expect(createHostBrokeredSecretReader(never)({ kind: "keychain", account: "x" })).rejects.toMatchObject({ code: "io" });
  });
});

// --- End to end: query() -> the runtime -> the real Anthropic adapter -> a loopback fake --------------

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}

test("end to end: the host's material reaches ONLY the provider request -- no frame, stderr line or file carries it", async () => {
  const seenKeys: string[] = [];
  const fake = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      seenKeys.push(req.headers.get("x-api-key") ?? "");
      await req.text();
      const events: Array<[string, unknown]> = [
        ["message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], usage: { input_tokens: 1, output_tokens: 1 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "brokered hello" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }],
        ["message_stop", { type: "message_stop" }],
      ];
      return new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    },
  });
  const home = mkdtempSync(join(tmpdir(), "winter-host-creds-"));
  temps.push(home);
  const asks: CredentialResolveRequest[] = [];
  const stderr: string[] = [];
  const frames: string[] = [];
  // A session on a REAL catalog provider installs a live advisor executor in the process-wide registry;
  // put the module-load default back so no later test file inherits this session's.
  const advisorBefore = getRegisteredTool(ADVISOR_TOOL_NAME)?.executor;
  try {
    const q = query({
      prompt: "hi",
      options: {
        model: "anthropic/claude-sonnet-5",
        provider: { providerId: "anthropic", authRef: { kind: "keychain", account: "anthropic:default" }, connection: { baseUrl: `http://127.0.0.1:${fake.port}`, local: true } },
        onCredentialResolve: async (req): Promise<CredentialResolveAnswer> => {
          asks.push(req);
          return req.ref.account === "anthropic:default" ? { ok: true, material: JSON.stringify({ kind: "api-key", key: SECRET }), generation: 1 } : { ok: false, reason: "not_allowed" };
        },
        spawnClaudeCodeProcess: (opts) => {
          const proc = inMemoryProcess(opts.args, echoProvider, undefined, { WINTER_HOME: home, HOME: home });
          void (async () => {
            for await (const line of proc.stderr ?? []) stderr.push(String(line));
          })();
          return proc;
        },
      },
    });
    for await (const msg of q) frames.push(JSON.stringify(msg));
  } finally {
    fake.stop(true);
    if (advisorBefore !== undefined) replaceExecutor(ADVISOR_TOOL_NAME, advisorBefore);
  }
  expect(seenKeys).toContain(SECRET); // the provider request carried it
  expect(asks.map((a) => a.ref.account)).toContain("anthropic:default");
  expect(JSON.stringify(frames)).toContain("brokered hello");
  expect(JSON.stringify(frames)).not.toContain(SECRET);
  expect(stderr.join("")).not.toContain(SECRET);
  for (const file of filesUnder(home)) expect([file, readFileSync(file, "utf8").includes(SECRET)]).toEqual([file, false]);
}, 30_000);

test("a credential read parked on the channel BEFORE the engine exists goes on the wire only AFTER the init handshake", async () => {
  // Production wiring builds the stores before `runEngine`; a read issued then parks on the channel, and the
  // engine's bind wakes it -- which used to write its `credential_resolve` ahead of the handshake.
  const channel = createHostCredentialChannel();
  const early = createHostBrokeredSecretReader(channel)({ kind: "keychain", account: "exa:default" });
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({ config: { sessionId: "init-order", cwd: "/tmp/x", model: "winter-test/echo" }, input: runtime.input, output: runtime.output, provider: echoProvider, hostCredentialChannel: channel });
  host.output.write({ type: "user", text: "hi" });
  const seen: WinterFrame[] = [];
  let ended = false;
  for await (const f of host.input) {
    seen.push(f);
    if (f.type === "control_request" && (f as ControlRequestFrame).subtype === "credential_resolve") {
      host.output.write({ type: "control_response", requestId: (f as ControlRequestFrame).requestId, ok: true, payload: { ok: true, material: "exa-material", generation: 1 } });
    }
    if (!ended && f.type === "data" && (f as { message: { type: string } }).message.type === "result") {
      ended = true;
      host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
    }
  }
  await done;
  expect(seen[0]?.type).toBe("init");
  const resolveAt = seen.findIndex((f) => f.type === "control_request" && (f as ControlRequestFrame).subtype === "credential_resolve");
  expect(resolveAt).toBeGreaterThan(0);
  expect(await early).toBe("exa-material");
}, 20_000);
