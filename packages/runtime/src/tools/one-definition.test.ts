// ONE DEFINITION, ONE IMPLEMENTATION (user ruling R-8-1) — the tripwire.
//
// Winter's four default tools are declared once, in `@yanlinglabs/winter-agent-sdk/tools`, and this
// runtime BINDS them. Six registry entries reference those four definitions: the native
// `SendMessage`/`ListAgents`/`ReadNotifications`/`advisor`, plus the two canonical standing-server
// twins the official branch's `toolAliases` redirect into (WS-09 §10: "an alias target MUST accept
// the native arguments exactly").
//
// THE ASSERTION IS OBJECT IDENTITY (`toBe`), NOT EQUALITY. Two structurally identical schema
// literals are exactly the state this ruling ended: they pass every equality check on the day they
// are written and drift the moment one of them is edited. `toBe` fails the second a descriptor goes
// back to owning a literal, which is the only thing that can actually be checked here.
//
// AND THE POLICY FIELDS ARE STILL THIS RUNTIME'S (ruling P-8). The SDK definition carries the
// model-facing half — name, description, schemas, permission class. `source`, `exposure`,
// `availability`, `capabilityRequirements`, `disposition` and `deferred` are supplied here, per
// descriptor, and the frozen snapshot below is what proves this task did not move any of them.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ADVISOR_DEFINITION, LIST_AGENTS_DEFINITION, READ_NOTIFICATIONS_DEFINITION, SEND_MESSAGE_DEFINITION, type WinterToolDefinition } from "@yanlinglabs/winter-agent-sdk/tools";

import "./descriptors/index.ts";
import { getRegisteredTool, resolveDeferral, type DeferralActivation, type JSONSchema, type ToolDescriptor } from "./registry.ts";

/** Every registry entry that binds an SDK definition, and which one it binds. */
const BOUND: ReadonlyArray<readonly [string, WinterToolDefinition]> = [
  ["SendMessage", SEND_MESSAGE_DEFINITION],
  ["ListAgents", LIST_AGENTS_DEFINITION],
  ["ReadNotifications", READ_NOTIFICATIONS_DEFINITION],
  ["advisor", ADVISOR_DEFINITION],
  // The twins bind the SAME definition as their native, which is what "an alias target accepts the
  // native arguments exactly" means when it is structural rather than aspirational.
  ["mcp__winter__send_message", SEND_MESSAGE_DEFINITION],
  ["mcp__winter__list_agents", LIST_AGENTS_DEFINITION],
];

function descriptorFor(name: string): ToolDescriptor {
  const registered = getRegisteredTool(name);
  if (registered === undefined) throw new Error(`not registered: ${name}`);
  return registered.descriptor;
}

describe("R-8-1: the default tools are BOUND from the SDK, never re-declared here", () => {
  for (const [name, definition] of BOUND) {
    test(`${name} carries the SDK definition's schema OBJECTS, not copies of them`, () => {
      const descriptor = descriptorFor(name);
      expect(descriptor.inputSchema).toBe(definition.inputSchema as unknown as JSONSchema);
      if (definition.outputSchema === undefined) {
        expect(descriptor.outputSchema).toBeUndefined();
      } else {
        expect(descriptor.outputSchema).toBe(definition.outputSchema as unknown as JSONSchema);
      }
    });

    test(`${name} carries the SDK definition's description and permission class`, () => {
      const descriptor = descriptorFor(name);
      expect(descriptor.description).toEqual(definition.description);
      expect(descriptor.permissionClass).toEqual(definition.permissionClass);
    });
  }

  test("the natives register under the definition's `builtinName`, the twins under the brand's MCP name", () => {
    // Each of the four DECLARES a built-in name, and the native entry is registered under it -- the
    // bare `toolName` fallback in `builtinNameOf` exists for a future definition that has no official
    // counterpart, and must not be what any of these four is silently using.
    expect([SEND_MESSAGE_DEFINITION, LIST_AGENTS_DEFINITION, READ_NOTIFICATIONS_DEFINITION, ADVISOR_DEFINITION].map((d) => d.builtinName)).toEqual([
      "SendMessage",
      "ListAgents",
      "ReadNotifications",
      "advisor",
    ]);
    expect(descriptorFor("SendMessage").canonicalName).toBe("SendMessage");
    expect(descriptorFor("ListAgents").canonicalName).toBe("ListAgents");
    expect(descriptorFor("ReadNotifications").canonicalName).toBe("ReadNotifications");
    expect(descriptorFor("advisor").canonicalName).toBe("advisor");
    expect(descriptorFor("mcp__winter__send_message").canonicalName).toBe(`mcp__winter__${SEND_MESSAGE_DEFINITION.toolName}`);
    expect(descriptorFor("mcp__winter__list_agents").canonicalName).toBe(`mcp__winter__${LIST_AGENTS_DEFINITION.toolName}`);
  });

  test("the native and its twin share ONE schema object -- the alias target can never drift from its alias", () => {
    expect(descriptorFor("mcp__winter__send_message").inputSchema).toBe(descriptorFor("SendMessage").inputSchema);
    expect(descriptorFor("mcp__winter__list_agents").inputSchema).toBe(descriptorFor("ListAgents").inputSchema);
    expect(descriptorFor("mcp__winter__list_agents").outputSchema).toBe(descriptorFor("ListAgents").outputSchema);
  });
});

// --- the frozen pre-binding snapshot ---------------------------------------------------------------

interface SnapshotEntry {
  canonicalName: string;
  advertisedName: string;
  source: string;
  exposure: string;
  permissionClass: string;
  deferred: boolean | string[] | null;
  inputSchema: { required?: string[]; properties?: Record<string, unknown> };
  outputSchema: { required?: string[]; properties?: Record<string, unknown> } | null;
  deferralWithToolSearchActive: string;
  deferralWithToolSearchInactive: string;
}

const SNAPSHOT = JSON.parse(readFileSync(fileURLToPath(new URL("./__snapshots__/default-tools.json", import.meta.url)), "utf8")) as Record<string, SnapshotEntry>;

const ACTIVE: DeferralActivation = { enableToolSearch: "true", providerSupportsToolSearch: true, deferrableContextShare: 100 };
const INACTIVE: DeferralActivation = { enableToolSearch: "false", providerSupportsToolSearch: false, deferrableContextShare: 0 };

/**
 * The STRUCTURAL subset, per the controller's ruling: identity, registry policy, deferral verdicts,
 * and each schema's `required` list and property NAMES.
 *
 * Description strings and per-property description TEXT are deliberately excluded: this task unifies
 * two wordings onto the SDK's, which is a change a reviewer should read in the diff rather than have
 * a snapshot refuse. The full dump is committed beside this subset for exactly that reading.
 */
function structural(descriptor: ToolDescriptor): Record<string, unknown> {
  const shape = (schema: JSONSchema | undefined): { required: string[]; properties: string[] } | null =>
    schema === undefined ? null : { required: [...(schema.required ?? [])], properties: Object.keys(schema.properties ?? {}) };
  return {
    canonicalName: descriptor.canonicalName,
    advertisedName: descriptor.advertisedName,
    source: descriptor.source,
    exposure: descriptor.exposure,
    permissionClass: descriptor.permissionClass,
    deferred: descriptor.deferred ?? null,
    inputSchema: shape(descriptor.inputSchema),
    outputSchema: shape(descriptor.outputSchema),
    deferralWithToolSearchActive: resolveDeferral(descriptor, "default", ACTIVE),
    deferralWithToolSearchInactive: resolveDeferral(descriptor, "default", INACTIVE),
  };
}

function structuralFromSnapshot(entry: SnapshotEntry): Record<string, unknown> {
  const shape = (schema: SnapshotEntry["inputSchema"] | null): { required: string[]; properties: string[] } | null =>
    schema === null ? null : { required: [...(schema.required ?? [])], properties: Object.keys(schema.properties ?? {}) };
  return {
    canonicalName: entry.canonicalName,
    advertisedName: entry.advertisedName,
    source: entry.source,
    exposure: entry.exposure,
    permissionClass: entry.permissionClass,
    deferred: entry.deferred,
    inputSchema: shape(entry.inputSchema),
    outputSchema: shape(entry.outputSchema),
    deferralWithToolSearchActive: entry.deferralWithToolSearchActive,
    deferralWithToolSearchInactive: entry.deferralWithToolSearchInactive,
  };
}

describe("the registry's verdict on the six is UNCHANGED by binding them from the SDK", () => {
  test("the snapshot covers exactly the six", () => {
    expect(Object.keys(SNAPSHOT).sort()).toEqual([...BOUND].map(([name]) => name).sort());
  });

  for (const [name] of BOUND) {
    test(`${name}: identity, policy, deferral verdict and schema SHAPE match the frozen snapshot`, () => {
      expect(structural(descriptorFor(name))).toEqual(structuralFromSnapshot(SNAPSHOT[name]!));
    });
  }
});
