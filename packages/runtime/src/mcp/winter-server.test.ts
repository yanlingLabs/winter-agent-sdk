// P7a spine, Step 5 (D29): the standing Winter server advertises NOTHING, and the advisor is native.
//
// WHAT THIS FILE USED TO ASSERT, and why it changed. Phase 4 Task 2 pinned a descriptor-identity
// fixture here: the server's own `advisor` tool had to be byte-identical to the registry descriptor
// for `mcp__winter__advisor` (WS-06 §6 obligation 5, WS-09 §11 item 11). D29 retired that name. The
// advisor is a BARE NATIVE tool now, dispatched through Winter's own registry, and the standing
// server registers nothing at all — so the identity obligation has nothing left to compare, and
// keeping the old fixture would have meant keeping the registration it was written to guard.
//
// The replacement is the assertion the retirement actually needs: a REAL @modelcontextprotocol/sdk
// Client, over a real (in-memory) transport pair, sees an EMPTY tool list. That is what proves the
// server-qualified twin is gone from the surface a client observes, rather than merely renamed in a
// descriptor file — and it is the same empirical method (a live client round trip, never
// private-field introspection) the original fixture used.
import { describe, test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWinterServer, WINTER_SERVER_NAME } from "./winter-server.ts";
import { getRegisteredTool } from "../tools/registry.ts";
import { ADVISOR_TOOL_NAME } from "../tools/impl/advisor.ts";

/**
 * Connects a real client over an in-memory transport pair and hands the caller the connected client
 * for the duration of `body`. Always closes both ends.
 */
async function withConnectedClient<T>(server: ReturnType<typeof createWinterServer>, body: (client: Client) => Promise<T>): Promise<T> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "winter-server-test-client", version: "0.0.1" });
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    return await body(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("createWinterServer after D29: an empty standing server", () => {
  test("a real MCP client sees NO tools capability at all — the server-qualified advisor twin is gone from the wire", async () => {
    // MEASURED, not assumed: a `McpServer` with no `registerTool` call never declares the `tools`
    // capability, so `tools/list` is not merely empty — it is Method not found (-32601). That is a
    // STRONGER statement than an empty array (an empty array would still advertise the capability),
    // and it is the honest description of what a client actually observes, so it is what this pins.
    await withConnectedClient(createWinterServer(), async (client) => {
      expect(client.getServerCapabilities()?.tools).toBeUndefined();
      await expect(client.listTools()).rejects.toThrow(/Method not found/);
    });
  });

  test("the server is still a real, connectable server with its own name", async () => {
    // The seam survives the emptying: a P7/P8 product-layer tool registers HERE, and this is the
    // proof that "empty" did not quietly become "unusable".
    expect(WINTER_SERVER_NAME).toBe("winter");
    await withConnectedClient(createWinterServer(), async (client) => {
      expect(client.getServerVersion()).toMatchObject({ name: WINTER_SERVER_NAME });
    });
  });

  test("createWinterServer is re-callable -- a second call produces an independent, equally-empty server", async () => {
    const capsOf = async (): Promise<unknown> => withConnectedClient(createWinterServer(), async (client) => client.getServerCapabilities());
    expect(await capsOf()).toEqual(await capsOf());
  });

  test("the advisor lives in the REGISTRY under its bare native name, not on this server", async () => {
    // The other half of the retirement: the capability did not disappear with the registration.
    await import("../tools/impl/advisor.ts");
    expect(ADVISOR_TOOL_NAME).toBe("advisor");
    const entry = getRegisteredTool(ADVISOR_TOOL_NAME);
    expect(entry?.descriptor.canonicalName).toBe("advisor");
    expect(entry?.descriptor.advertisedName).toBe("advisor");
    expect(entry?.descriptor.source).toBe("builtin");
    // And nothing is registered under the retired server-qualified name.
    expect(getRegisteredTool(`mcp__${WINTER_SERVER_NAME}__advisor`)).toBeUndefined();
  });
});
