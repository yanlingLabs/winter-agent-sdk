// WS-23 (reasoning-state, user decision 2): a message another model produced keeps its readable
// reasoning as a `<recovered_reasoning>` decoration, but the production renderer BOUNDS it -- each
// decoration and all of them together -- keeping the newest. Driven through the real session wiring
// (`buildSessionProvider`) and the real Responses adapter against a loopback, reading the request body.
import { afterEach, describe, expect, test } from "bun:test";
import type { RuntimeConfig } from "@yanlinglabs/winter-agent-sdk";
import { RECOVERED_REASONING_TAG, createMemoryCredentialStore, reasoningBlockItems } from "@yanlinglabs/winter-provider-runtime";
import type { ProviderMessage } from "../engine.ts";
import { DECORATION_CHAR_BUDGET, MAX_DECORATION_CHARS, buildSessionProvider } from "./session-provider.ts";
import { fakeResponsesCatalog, startResponsesFake, type ResponsesFake } from "./responses-fake.test-support.ts";

const TARGET = "openai/gpt-5.6-sol";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

/** A Claude turn whose (long) thinking rides the sidecar, as the engine keeps it in memory. */
function claudeTurn(i: number, thinking: string): ProviderMessage {
  return {
    role: "assistant",
    content: `claude answer ${i}`,
    uuid: `claude-${i}`,
    origin: { providerId: "anthropic", modelKey: "anthropic/claude-opus-5-5", family: "anthropic", continuationDomain: "anthropic/claude-opus-5-5" },
    nativeState: { family: "anthropic", continuationDomain: "anthropic/claude-opus-5-5", items: reasoningBlockItems([{ at: 0, block: { type: "thinking", thinking, signature: `SIG-${i}` } }]) },
  };
}

async function decorationsSent(history: ProviderMessage[]): Promise<string[]> {
  return (await decorationRounds(history)).at(-1)!;
}

/** One session's wiring rendering each history in turn (the same renderer, so its sticky decisions carry), the decorations of each request. */
async function decorationRounds(...histories: ProviderMessage[][]): Promise<string[][]> {
  const fake: ResponsesFake = await startResponsesFake(() => ({ items: [{ type: "text", text: "ok" }] }));
  cleanups.push(() => fake.close());
  const catalog = fakeResponsesCatalog("openai", fake.url, [TARGET]);
  const config = { sessionId: "s-cap", cwd: "/winter-fixture", model: TARGET, provider: { providerId: "openai", authRef: { kind: "inline", value: "fixture" }, connection: { baseUrl: fake.url, local: true } } } as unknown as RuntimeConfig;
  const wiring = buildSessionProvider({ config, env: {}, catalog, credentials: createMemoryCredentialStore() });
  for (const history of histories) await wiring.provider.generate({ model: TARGET, messages: history });
  expect(fake.requests).toHaveLength(histories.length);
  return fake.requests.map((request) => decorationsIn(request));
}

function decorationsIn(request: ResponsesFake["requests"][number]): string[] {
  const raw = request.raw;
  expect(raw).not.toContain("SIG-");
  // Every string in the body, walked; each decoration is matched out of the string that carries it.
  const strings: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === "object" && value !== null) Object.values(value).forEach(walk);
  };
  walk(request.body);
  const pattern = new RegExp(`<${RECOVERED_REASONING_TAG}[^>]*>[\\s\\S]*?</${RECOVERED_REASONING_TAG}>`, "g");
  return strings.flatMap((text) => [...text.matchAll(pattern)].map((m) => m[0]));
}

describe("the production renderer's decoration caps (WS-23 decision 2)", () => {
  test("each decoration stays within its own cap, all of them within the budget, and the NEWEST survive", async () => {
    const history: ProviderMessage[] = [];
    for (let i = 0; i < 12; i++) {
      history.push({ role: "user", content: `question ${i}` });
      history.push(claudeTurn(i, `thought-${i} `.repeat(1_500)));
    }
    history.push({ role: "user", content: "now you" });
    const decorations = await decorationsSent(history);
    expect(decorations.length).toBeGreaterThan(0);
    for (const d of decorations) expect(d.length).toBeLessThanOrEqual(MAX_DECORATION_CHARS);
    expect(decorations.reduce((n, d) => n + d.length, 0)).toBeLessThanOrEqual(DECORATION_CHAR_BUDGET);
    // Newest first: the last Claude turn's reasoning is carried, the first one's is not.
    expect(decorations.some((d) => d.includes("thought-11"))).toBe(true);
    expect(decorations.some((d) => d.includes("thought-0 "))).toBe(false);
  });

  test("a short history is carried whole", async () => {
    const decorations = await decorationsSent([{ role: "user", content: "q" }, claudeTurn(0, "brief reasoning"), { role: "user", content: "now you" }]);
    expect(decorations).toHaveLength(1);
    expect(decorations[0]).toContain("brief reasoning");
  });
});

describe("review r1, M-1: the decoration choice is sticky per target model", () => {
  test("a history that grows past the budget never changes what the target was already sent", async () => {
    const stint = (from: number, n: number): ProviderMessage[] => Array.from({ length: n }, (_, k) => [{ role: "user" as const, content: `q ${from + k}` }, claudeTurn(from + k, `thought-${from + k} `.repeat(1_500))]).flat();
    const first = [...stint(0, 4), { role: "user" as const, content: "gpt, your turn" }];
    const second = [...first, { role: "assistant" as const, content: "gpt answer" }, ...stint(4, 8), { role: "user" as const, content: "gpt again" }];
    const [before, after] = await decorationRounds(first, second);
    // Every decoration the first request carried is carried again, byte for byte, in the same order.
    expect(after!.slice(0, before!.length)).toEqual(before!);
    expect(after!.reduce((n, d) => n + d.length, 0)).toBeLessThanOrEqual(DECORATION_CHAR_BUDGET);
  });
});
