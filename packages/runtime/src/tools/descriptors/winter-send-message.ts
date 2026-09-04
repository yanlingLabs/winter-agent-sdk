// WS-09 §10 / WS-10 §15 -- the CANONICAL `mcp__winter__send_message` entry on the standing Winter
// server (`winter`), created by Phase 4 Task 8 (rider 15). Lane D's own report named this as one of
// its two genuine cross-lane NEEDS_CONTEXT items: "canonical mcp__winter__send_message /
// mcp__winter__list_agents descriptors don't exist anywhere in this repo", and creating one is
// descriptor-authoring territory a lane may not enter.
//
// WHY IT EXISTS AT ALL: WS-10 §15 names this exact pair as the redirect target
// [WS-14]'s official-branch `toolAliases` wiring points `SendMessage`/`ListAgents` at. For that
// alias to be answerable, the canonical name has to be a real, registered tool with the NATIVE
// schema (WS-09 §10: "an alias target MUST accept the native arguments exactly; a genuinely
// different schema requires a separately named MCP tool"). The schema below is therefore a
// deliberate MIRROR of descriptors/send-message.ts's own -- not a variant -- and
// tools/impl/send-message.ts installs the IDENTICAL executor object under both names, so the two
// can never diverge behaviourally.
//
// `deferred: true` AT THE SOURCE (RULING P4-E, verbatim, and the controller's own mid-task
// instruction to Lane D): "the canonical `mcp__winter__*` entry stays deferred and is declared
// `deferred: true` at its source". Declaring it eager and merely suppressing it at the partition
// layer would produce a real visibility/gating mismatch -- it would vanish from the advertised
// listing (looking deferred) while still resolving EAGER at the execution boundary
// (isLoadFirstBlocked), i.e. callable by name with no `select:` first. Declared here, the two
// layers agree whenever Tool Search is active.
//
// Duplicate suppression (WS-09 §10's "the model normally sees ONE SendMessage") happens in
// `toolsearch/aliases.ts`, over the Winter-branch canonical alias table (`WINTER_CANONICAL_ALIASES`,
// declared there) that engine.ts hands to its advertised-partition call.
//
// STALE-COMMENT SWEEP (P4 fix wave, KNOWN (8)): this paragraph used to end "...why it is applied to
// SUPPRESSION only and never to permission identity". RULING P4-E was AMENDED after the whole-branch
// review's CRITICAL C2 found the escape that split left open -- denying the NATIVE name unadvertised
// it, which DISABLED suppression and surfaced THIS descriptor eagerly, executing the same executor
// object with no deny rule or hook matcher matching it. The table now feeds identity too, but
// BIDIRECTIONALLY and strictest-of, so `disallowedTools: ["SendMessage"]` still matches (the property
// the original split existed to protect) AND this entry is hidden whenever its native is denied or
// excluded. See `resolvePermissionIdentity`/`hideAliasExcludedTwins` in toolsearch/aliases.ts.
//
// `source: "mcp"` matches the `mcp__winter__advisor` precedent exactly (descriptors/advisor.ts): a
// standing-server tool is registered with MCP identity so it is rule-addressable under its canonical
// name, even though the in-process server object itself (mcp/winter-server.ts) registers separately.
// It also matters mechanically: `resolveDeferral` short-circuits `source: "builtin"` to "eager"
// unconditionally ("core built-ins... never deferred through the public surface"), so a builtin-
// sourced canonical entry could never be deferred at all.
import { stub } from "./_shared.ts";

stub({
  canonicalName: "mcp__winter__send_message",
  advertisedName: "mcp__winter__send_message",
  source: "mcp",
  // Byte-mirrors descriptors/send-message.ts's own inputSchema (WS-10 §10.1's pinned shape).
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "string", maxLength: 300, description: 'no newline, no "*" broadcast' },
      message: { type: "string", description: 'required; defaults "" for pure idle subscription' },
      summary: { type: "string", maxLength: 200 },
      notify_when_idle: { type: "boolean", description: "one-shot; main conversation -> same-machine session only" },
    },
    required: ["to", "message"],
  },
  description:
    "Canonical Winter-server entry for SendMessage ([WS-10] §15): the alias target the official branch redirects the native SendMessage name to. Accepts the native arguments exactly.",
  searchHint: "send message agent session peer child steer resume notify idle",
  exposure: "deferred",
  permissionClass: "messaging",
  availability: {},
  capabilityRequirements: ["winter.global-messaging"],
  deferred: true,
  disposition: "implement-now",
});
