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
  const fake: ResponsesFake = await startResponsesFake(() => ({ items: [{ type: "text", text: "ok" }] }));
  cleanups.push(() => fake.close());
  const catalog = fakeResponsesCatalog("openai", fake.url, [TARGET]);
  const config = { sessionId: "s-cap", cwd: "/winter-fixture", model: TARGET, provider: { providerId: "openai", authRef: { kind: "inline", value: "fixture" }, connection: { baseUrl: fake.url, local: true } } } as unknown as RuntimeConfig;
  const wiring = buildSessionProvider({ config, env: {}, catalog, credentials: createMemoryCredentialStore() });
  await wiring.provider.generate({ model: TARGET, messages: history });
  expect(fake.requests).toHaveLength(1);
  const raw = fake.requests[0]!.raw;
  expect(raw).not.toContain("SIG-");
  // Every string in the body, walked; each decoration is matched out of the string that carries it.
  const strings: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === "object" && value !== null) Object.values(value).forEach(walk);
  };
  walk(fake.requests[0]!.body);
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
