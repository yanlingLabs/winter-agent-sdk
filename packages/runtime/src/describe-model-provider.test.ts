// E4 sweep (dist-session fixes, 2026-09-22): the OTHER bare-id catalog lookup on the request path --
// the `# Environment` section's model line (`describeModel`).
//
// The Winter daemon spawns the Winter leg with the BARE model id plus `Options.provider`, so the
// engine's `currentModel` is e.g. `deepseek-v4-flash`. `describeModel` searched the whole catalog for
// the first row whose key, upstream id or alias matched -- twelve providers serve `deepseek-v4-flash`,
// so a deepseek-anthropic session's system prompt named the model by `alibaba-cn`'s row. It now takes
// the session's provider, and without one a bare id shared by several providers names none of them.
import { describe, expect, test } from "bun:test";
import type { RuntimeConfig } from "@yanlinglabs/winter-agent-sdk";
import { loadCatalog, type WinterCatalog } from "@yanlinglabs/winter-provider-catalog";
import { runEngine, type Provider } from "./engine.ts";
import { createInMemoryChannel } from "./protocol/channel.ts";
import { stubExecutor } from "./provider/mock.ts";
import { describeCatalogModel } from "./production-wiring.ts";

const row = (key: string) => loadCatalog().models.find((m) => m.key === key)!;

describe("describeCatalogModel: the session's own provider's row", () => {
  test("a bare id names the row of the provider it was asked under -- never another provider's", () => {
    const catalog = loadCatalog();
    expect(describeCatalogModel(catalog, "deepseek-v4-flash", "deepseek-anthropic")?.displayName).toBe(row("deepseek-anthropic/deepseek-v4-flash").displayName);
    expect(describeCatalogModel(catalog, "deepseek-v4-flash", "deepseek")?.displayName).toBe(row("deepseek/deepseek-v4-flash").displayName);
    expect(describeCatalogModel(catalog, "deepseek-v4-flash", "alibaba-cn")?.displayName).toBe(row("alibaba-cn/deepseek-v4-flash").displayName);
  });

  test("a provider-local id that is ANOTHER provider's key (novita's `deepseek/deepseek-v4-flash`) names the asking provider's row", () => {
    expect(describeCatalogModel(loadCatalog(), "deepseek/deepseek-v4-flash", "novita")?.displayName).toBe(row("novita/deepseek/deepseek-v4-flash").displayName);
  });

  test("two passes under a provider: an ALIAS never shadows another row's upstream id", () => {
    // `p/a` lists `b` as an alias and sorts first; `p/b`'s own upstream id IS `b`. One `find` over
    // key|upstream|alias named `p/a`.
    const catalog = {
      models: [
        { key: "p/a", providerId: "p", upstreamId: "a", aliases: ["b"], displayName: "Row A" },
        { key: "p/b", providerId: "p", upstreamId: "b", aliases: [], displayName: "Row B" },
      ],
    } as unknown as WinterCatalog;
    expect(describeCatalogModel(catalog, "b", "p")?.displayName).toBe("Row B");
    expect(describeCatalogModel(catalog, "a", "p")?.displayName).toBe("Row A");
  });

  test("with no provider: a catalog key resolves; a bare id served by several providers names NONE of them", () => {
    const catalog = loadCatalog();
    expect(describeCatalogModel(catalog, "deepseek/deepseek-v4-flash")?.displayName).toBe(row("deepseek/deepseek-v4-flash").displayName);
    expect(describeCatalogModel(catalog, "deepseek-v4-flash")).toBeUndefined();
    expect(describeCatalogModel(catalog, "winter-test/echo")).toBeUndefined();
  });
});

describe("the engine asks for its model line under the session's provider", () => {
  test("a session spawned with a bare model id and a provider identity passes both", async () => {
    const calls: Array<[string, string | undefined]> = [];
    const provider: Provider = { generate: async () => ({ kind: "text", text: "done" }) };
    const { host, runtime } = createInMemoryChannel();
    const config = { sessionId: "e4", cwd: "/tmp/x", model: "deepseek-v4-flash", persistSession: false } as RuntimeConfig;
    const done = runEngine({
      config,
      input: runtime.input,
      output: runtime.output,
      provider,
      tools: stubExecutor,
      providerIdentity: { providerId: "deepseek-anthropic", modelKey: "deepseek-anthropic/deepseek-v4-flash", family: "anthropic", adapterId: "winter.anthropic-messages", adapterVersion: "x", catalogVersion: "x", authRefKind: "inline" },
      describeModel: (model: string, providerId?: string) => {
        calls.push([model, providerId]);
        return undefined;
      },
    } as never);
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
    for await (const _ of host.input) void _;
    await done;
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call[1]).toBe("deepseek-anthropic");
  });
});
