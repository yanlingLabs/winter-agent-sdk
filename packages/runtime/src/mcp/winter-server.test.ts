// Phase 4 Task 2: the standing winter server's own descriptor-identity fixture (WS-06 §6 obligation
// 5, WS-09 §11 item 11: "both branches advertise byte-identical descriptors ... for
// mcp__winter__advisor"). Drives a REAL @modelcontextprotocol/sdk Client against the server object
// createWinterServer() returns, over a real (in-memory) transport pair -- not a private-field
// introspection -- so this proves what an ACTUAL MCP client would observe, matching this task's own
// empirical-verification method (see winter-server.ts's own header comment).
import { describe, test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWinterServer } from "./winter-server.ts";
import { getRegisteredTool, registerTool, unregisterToolForTest, type RegisteredTool } from "../tools/registry.ts";

const ADVISOR_CANONICAL_NAME = "mcp__winter__advisor";

async function listToolsFrom(server: ReturnType<typeof createWinterServer>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "winter-server-test-client", version: "0.0.1" });
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    return await client.listTools();
  } finally {
    await client.close();
    await server.close();
  }
}

describe("createWinterServer: mcp__winter__advisor descriptor identity (WS-06 §6 obligation 5)", () => {
  test("the server's own advisor tool is byte-identical to the registry descriptor on every field both surfaces share", async () => {
    const registryEntry = getRegisteredTool(ADVISOR_CANONICAL_NAME);
    expect(registryEntry).toBeDefined();
    const descriptor = registryEntry!.descriptor;

    const server = createWinterServer();
    const { tools } = await listToolsFrom(server);
    const advisor = tools.find((t) => t.name === "advisor");
    expect(advisor).toBeDefined();

    // Canonical-name mapping: the server's bare "advisor" + WS-09 §1.3's mcp__<server>__<tool>
    // convention reconstructs the exact registry canonicalName.
    expect(`mcp__winter__${advisor!.name}`).toBe(descriptor.canonicalName);
    expect(advisor!.description).toBe(descriptor.description);
    // Byte-identical inputSchema: advisor's own pinned `{}` shape (WS-06 §4) round-trips through an
    // OMITTED registerTool `inputSchema` config as exactly {type:"object", properties:{}} --
    // verified empirically against the real SDK before writing winter-server.ts.
    // Cast both sides to `unknown`: registry.ts's own JSONSchema is a deliberately wide, structural
    // "self-describing... not a validator" type (that file's own comment), while the real SDK's
    // Client.listTools() return type is narrowly literal-typed (`type: "object"`) -- the two are
    // runtime-deeply-equal but not mutually structurally assignable, which is a type-level fact
    // about two independently-declared shapes, not a real behavioral divergence.
    expect(advisor!.inputSchema as unknown).toEqual(descriptor.inputSchema as unknown);
    expect(advisor!.annotations).toEqual(descriptor.annotations);
    expect(advisor!._meta).toEqual(descriptor._meta);

    // NOT compared: `execution` -- a real MCP-protocol bookkeeping field
    // (@modelcontextprotocol/sdk's own default, `{taskSupport: "forbidden"}`) the registry
    // descriptor has no equivalent concept for at all; this task's "byte-identical" obligation is
    // scoped to the fields WS-06 §1.1's own ToolDescriptor actually carries, not the full MCP
    // protocol surface a real server necessarily adds on top.
  });

  test("advisor's annotations/_meta are absent on BOTH surfaces when the registry descriptor carries neither (today's actual P3 state)", async () => {
    const descriptor = getRegisteredTool(ADVISOR_CANONICAL_NAME)!.descriptor;
    expect(descriptor.annotations).toBeUndefined();
    expect(descriptor._meta).toBeUndefined();

    const { tools } = await listToolsFrom(createWinterServer());
    const advisor = tools.find((t) => t.name === "advisor")!;
    expect(advisor.annotations).toBeUndefined();
    expect(advisor._meta).toBeUndefined();
  });

  test("createWinterServer is re-callable -- a second call produces an independent, equally-correct server", async () => {
    const first = await listToolsFrom(createWinterServer());
    const second = await listToolsFrom(createWinterServer());
    expect(second.tools.find((t) => t.name === "advisor")).toEqual(first.tools.find((t) => t.name === "advisor"));
  });

  test("throws a clear error when the advisor descriptor is not registered yet", () => {
    // Synchronous save/remove/restore of a REAL registry entry -- safe here specifically because
    // every statement below is synchronous (no `await` anywhere in this test body), so nothing else
    // in this `bun test` process can observe the registry mid-mutation (registry.ts's own header:
    // module state is process-wide, but bun runs one test body to completion before starting the
    // next). Restores the EXACT captured object afterward -- never a re-typed duplicate -- so this
    // leaves no drift risk for any other test file in the same run.
    const saved: RegisteredTool | undefined = getRegisteredTool(ADVISOR_CANONICAL_NAME);
    expect(saved).toBeDefined();
    unregisterToolForTest(ADVISOR_CANONICAL_NAME);
    try {
      expect(() => createWinterServer()).toThrow(/no registry descriptor found/);
    } finally {
      registerTool(saved!);
    }
    // Restored: a subsequent call must succeed again exactly as before.
    expect(getRegisteredTool(ADVISOR_CANONICAL_NAME)).toEqual(saved);
  });
});
