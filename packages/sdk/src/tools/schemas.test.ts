// The model-facing schemas and the four definitions, pinned (WS-10 §10.1/§10.2, WS-06 §4).
//
// These are the values BOTH hosts advertise. A drift here is not a tidy-up item: it is the schema
// differing between the Winter branch and the official branch, in the one place a test in either
// host alone cannot see. That is exactly why they moved here (ruling R-8-1), so the assertions are
// literal rather than derived.
import { describe, expect, test } from "bun:test";

import {
  ADVISOR_DEFINITION,
  LIST_AGENTS_DEFINITION,
  LIST_AGENTS_FIELD_MAX,
  NATIVE_ADVISOR_OUTPUT_SCHEMA,
  NATIVE_ADVISOR_SCHEMA,
  NATIVE_LIST_AGENTS_OUTPUT_SCHEMA,
  NATIVE_LIST_AGENTS_SCHEMA,
  NATIVE_READ_NOTIFICATIONS_OUTPUT_SCHEMA,
  NATIVE_READ_NOTIFICATIONS_SCHEMA,
  NATIVE_SEND_MESSAGE_SCHEMA,
  READ_NOTIFICATIONS_DEFINITION,
  SEND_MESSAGE_DEFINITION,
  SEND_MESSAGE_SUMMARY_MAX,
  SEND_MESSAGE_TO_MAX,
  WINTER_DEFAULT_TOOL_DEFINITIONS,
} from "./index.ts";

describe("WS-10 §10.1/§10.2's bounds", () => {
  test("the three bounds are the pinned 300/200/256", () => {
    expect([SEND_MESSAGE_TO_MAX, SEND_MESSAGE_SUMMARY_MAX, LIST_AGENTS_FIELD_MAX]).toEqual([300, 200, 256]);
  });

  test("the SendMessage schema advertises those bounds where a reader will look for them", () => {
    expect(NATIVE_SEND_MESSAGE_SCHEMA.required).toEqual(["to", "message"]);
    const properties = NATIVE_SEND_MESSAGE_SCHEMA.properties ?? {};
    expect(Object.keys(properties)).toEqual(["to", "message", "summary", "notify_when_idle"]);
    expect((properties["to"] as { maxLength?: number }).maxLength).toBe(300);
    expect((properties["summary"] as { maxLength?: number }).maxLength).toBe(200);
  });

  test("ListAgents' two reserved fields are both capped at 256", () => {
    const properties = NATIVE_LIST_AGENTS_SCHEMA.properties ?? {};
    expect(Object.keys(properties)).toEqual(["channel", "q"]);
    for (const field of ["channel", "q"] as const) {
      expect([field, (properties[field] as { maxLength?: number }).maxLength]).toEqual([field, 256]);
    }
  });
});

describe("the pinned OUTPUT shapes", () => {
  test('ListAgents output is EXACTLY `{ listing: string }` -- and "exactly" is spelled `additionalProperties: false`', () => {
    expect(NATIVE_LIST_AGENTS_OUTPUT_SCHEMA).toEqual({
      type: "object",
      properties: { listing: { type: "string" } },
      required: ["listing"],
      additionalProperties: false,
    });
  });

  test("ReadNotifications takes `{}` and returns the drained page plus what is left", () => {
    expect(NATIVE_READ_NOTIFICATIONS_SCHEMA).toEqual({ type: "object", properties: {}, additionalProperties: false });
    expect(Object.keys(NATIVE_READ_NOTIFICATIONS_OUTPUT_SCHEMA.properties ?? {})).toEqual(["notifications", "remaining"]);
  });

  test("the advisor's input schema declares NO `additionalProperties` -- deliberate, never an omission", () => {
    // descriptors/advisor.ts's own N2 note: no executor in either host validates input against a
    // JSON Schema, so the keyword was decorative. One posture, applied here for both hosts.
    expect(NATIVE_ADVISOR_SCHEMA).toEqual({ type: "object", properties: {} });
    expect("additionalProperties" in NATIVE_ADVISOR_SCHEMA).toBe(false);
    expect(NATIVE_ADVISOR_OUTPUT_SCHEMA.required).toEqual(["advice", "model"]);
    expect(Object.keys(NATIVE_ADVISOR_OUTPUT_SCHEMA.properties ?? {})).toEqual(["advice", "model", "truncated"]);
  });
});

describe("the four definitions (ruling P-8: no registry policy fields)", () => {
  test("names are BARE, and the built-in alias key rides beside them", () => {
    expect(WINTER_DEFAULT_TOOL_DEFINITIONS.map((d) => [d.toolName, d.builtinName])).toEqual([
      ["send_message", "SendMessage"],
      ["list_agents", "ListAgents"],
      ["read_notifications", "ReadNotifications"],
      ["advisor", "advisor"],
    ]);
    for (const definition of WINTER_DEFAULT_TOOL_DEFINITIONS) {
      expect([definition.toolName, /^[a-z_]+$/.test(definition.toolName)]).toEqual([definition.toolName, true]);
    }
  });

  test("the barrel constant holds the four, in order, and they are the same objects", () => {
    expect(WINTER_DEFAULT_TOOL_DEFINITIONS).toHaveLength(4);
    expect([...WINTER_DEFAULT_TOOL_DEFINITIONS]).toEqual([SEND_MESSAGE_DEFINITION, LIST_AGENTS_DEFINITION, READ_NOTIFICATIONS_DEFINITION, ADVISOR_DEFINITION]);
    expect(WINTER_DEFAULT_TOOL_DEFINITIONS[0]).toBe(SEND_MESSAGE_DEFINITION);
    expect(WINTER_DEFAULT_TOOL_DEFINITIONS[3]).toBe(ADVISOR_DEFINITION);
  });

  test("each definition carries the SCHEMA OBJECT ITSELF -- one definition means one object identity", () => {
    expect(SEND_MESSAGE_DEFINITION.inputSchema).toBe(NATIVE_SEND_MESSAGE_SCHEMA);
    expect(LIST_AGENTS_DEFINITION.inputSchema).toBe(NATIVE_LIST_AGENTS_SCHEMA);
    expect(LIST_AGENTS_DEFINITION.outputSchema).toBe(NATIVE_LIST_AGENTS_OUTPUT_SCHEMA);
    expect(READ_NOTIFICATIONS_DEFINITION.inputSchema).toBe(NATIVE_READ_NOTIFICATIONS_SCHEMA);
    expect(READ_NOTIFICATIONS_DEFINITION.outputSchema).toBe(NATIVE_READ_NOTIFICATIONS_OUTPUT_SCHEMA);
    expect(ADVISOR_DEFINITION.inputSchema).toBe(NATIVE_ADVISOR_SCHEMA);
    expect(ADVISOR_DEFINITION.outputSchema).toBe(NATIVE_ADVISOR_OUTPUT_SCHEMA);
    // SendMessage has no pinned outputSchema (WS-10 §10.1) -- absent, never an empty object.
    expect(SEND_MESSAGE_DEFINITION.outputSchema).toBeUndefined();
  });

  test("permission classes follow the CALL, not the descriptor's provenance", () => {
    expect(WINTER_DEFAULT_TOOL_DEFINITIONS.map((d) => d.permissionClass)).toEqual(["messaging", "messaging", "messaging", "mcp"]);
  });

  test("RULING P-8: no registry policy field leaks into the shared definition", () => {
    // A shared `source`/`exposure`/`deferred` would silently decide Tool-Search eligibility for BOTH
    // hosts from one place -- and the runtime's own `resolveDeferral` short-circuits
    // `source: "builtin"` to eager, so the value is not even portable. Each host supplies its own.
    const forbidden = ["source", "exposure", "availability", "capabilityRequirements", "disposition", "deferred", "canonicalName", "advertisedName"];
    for (const definition of WINTER_DEFAULT_TOOL_DEFINITIONS) {
      const leaked = Object.keys(definition).filter((key) => forbidden.includes(key));
      expect([definition.toolName, leaked]).toEqual([definition.toolName, []]);
    }
  });

  test("every definition carries a real description -- the model-facing half is not optional", () => {
    for (const definition of WINTER_DEFAULT_TOOL_DEFINITIONS) {
      expect([definition.toolName, definition.description.length > 40]).toEqual([definition.toolName, true]);
    }
  });
});
