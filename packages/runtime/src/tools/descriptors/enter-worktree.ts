// WS-06 §3.3 "EnterWorktree" -- implement-now, captured, verbatim schema. Dual class in prose
// ("mode/edit") -- PRIMARY class picked here is "mode" (it changes session cwd + filesystem
// boundary, a posture change; the Manual-mode "permission required: Yes" column applies to it as a
// mode-class action). `name` creates under the project dot-dir's `worktrees/` (WS-01 §2.4).
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "EnterWorktree",
  advertisedName: "EnterWorktree",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      path: { type: "string" },
    },
  },
  description: "name creates a temporary git worktree under .winter/worktrees; path switches to a registered worktree under path rules. Changes session cwd + filesystem boundary.",
  exposure: "eager",
  permissionClass: "mode",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: [],
  disposition: "implement-now",
});
