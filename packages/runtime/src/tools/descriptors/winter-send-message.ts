// WS-09 §10 / WS-10 §15 -- the CANONICAL `send_message` entry on the standing Winter server,
// created by Phase 4 Task 8 (rider 15). Lane D's own report named this as one of its two genuine
// cross-lane NEEDS_CONTEXT items: "canonical standing-server send_message / list_agents descriptors
// don't exist anywhere in this repo", and creating one is descriptor-authoring territory a lane may
// not enter.
//
// P7a (D19): the name registered here is Winter's own (`mcpToolName(WINTER_BRAND, ...)`), because a
// descriptor file runs at MODULE LOAD, before any session's brand exists. A branded session renames
// this entry at wiring time -- `rebrandStandingServerTools` (tools/registry.ts), called once by
// `production-wiring.ts` and disposed with the session -- so the registered spelling and
// `toolsearch/aliases.ts`'s alias TARGET are always the same string.
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
// instruction to Lane D): "the canonical standing-server entry stays deferred and is declared
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
// `source: "mcp"` is this entry's own identity, not a borrowed precedent: a server-qualified twin is
// registered with MCP identity so it is rule-addressable under its canonical name, even though the
// in-process server object itself (mcp/winter-server.ts) registers separately. (The advisor USED to
// be the sibling instance of this shape; P7a/D29 gave it a bare native name and `source: "builtin"`,
// so this twin no longer has a companion.) It also matters mechanically: `resolveDeferral`
// short-circuits `source: "builtin"` to "eager"
// unconditionally ("core built-ins... never deferred through the public surface"), so a builtin-
// sourced canonical entry could never be deferred at all.
import { WINTER_BRAND, mcpToolName } from "@yanlinglabs/winter-agent-sdk";
import { SEND_MESSAGE_DEFINITION } from "@yanlinglabs/winter-agent-sdk/tools";

import { stub, definitionFields } from "./_shared.ts";

const NAME = mcpToolName(WINTER_BRAND, SEND_MESSAGE_DEFINITION.toolName);

stub({
  // R-8-1 CLOSES THIS FILE'S OWN WORRY. The paragraph above says the schema here is "a deliberate
  // MIRROR of descriptors/send-message.ts's own -- not a variant". A mirror is a promise; this is the
  // same object. Both names now spread ONE definition, so "the alias target accepts the native
  // arguments exactly" (WS-09 §10) is structural rather than reviewed -- including the DESCRIPTION,
  // which used to say "Canonical Winter-server entry for SendMessage" and is now the native's own.
  ...definitionFields(SEND_MESSAGE_DEFINITION),
  canonicalName: NAME,
  advertisedName: NAME,
  source: "mcp",
  exposure: "deferred",
  availability: {},
  capabilityRequirements: ["winter.global-messaging"],
  deferred: true,
  disposition: "implement-now",
});
