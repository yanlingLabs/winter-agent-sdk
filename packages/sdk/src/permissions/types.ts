// Task 3 (WS-07 §3.3): the sdk-side pinned-types home for the permissions surface. This file is
// TYPES ONLY (no runtime logic, no fs, no Bun globals) so it stays trivially Node-safe under the
// sdk-fence typecheck (tsconfig.sdk-fence.json) — the fence only matters for files that could
// reference a Bun-only API; a pure `.d.ts`-shaped module can never trip it, but the file still
// lives under packages/sdk/src so the same tsc pass covers it.
//
// SECTIONING: this file grows across three tasks — each section below is a hard boundary future
// tasks extend, never restructure:
//   Task 3  (this task) -- PermissionMode / PermissionBehavior / PermissionRuleValue (WS-07 §3.3
//           / §4, verbatim). Grammar-adjacent types the runtime's pure grammar.ts consumes.
//   Task 5  -- PermissionUpdate (the six-variant union) + PermissionUpdateDestination, verbatim
//           WS-07 §3.3.
//   Task 8  -- CanUseTool + PermissionResult + PermissionDecisionClassification, verbatim WS-07
//           §7.1/§7.2.
// Each addition is its own `// Task N (WS-07 §X):` banner immediately below this comment block —
// do not interleave unrelated fields into an earlier task's banner.

// --- Task 3 (WS-07 §4; derived-shapes-p2.md item (e), the frozen pin-time 0.3.250 declaration) ---
//
// Six-value public union, ARTIFACT ORDER preserved verbatim (derived-shapes-p2.md item (e) quotes
// the pinned declaration's own member order at sdk.d.ts:2234 — WS-07 §4's prose lists the same six
// members in a different order, which is irrelevant for a union type but this file follows the
// artifact's literal spelling+order per this task's shape-authority instruction). `"manual"` is
// deliberately NOT a member: derived-shapes item (e) shows it is a settings/CLI-layer alias that
// resolves to `"default"` before a typed PermissionMode value ever exists — never a seventh value
// here (WS-07 §4).
export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";

// --- Task 3 (WS-07 §3.3, verbatim) ---
//
// `PermissionRuleValue.ruleContent` is the exact `Tool(specifier)` rule-content grammar this
// package's runtime-side `grammar.ts` (packages/runtime/src/permissions/grammar.ts — deliberately
// NOT in this sdk package; see that file's own header) parses via `parseRule`. `toolName` here is
// the SETTINGS-LEVEL field name and is NOT always identical to a parsed rule's own `toolName`: for
// an MCP rule the settings `toolName` IS the (possibly globbed) `mcp__server__tool` string with no
// separate `ruleContent` at all (WS-07 §3's MCP bullet) — `ruleContent` is only ever present for
// tools that use the parenthetical-specifier grammar.
export type PermissionBehavior = "allow" | "deny" | "ask";
export type PermissionRuleValue = { toolName: string; ruleContent?: string };
