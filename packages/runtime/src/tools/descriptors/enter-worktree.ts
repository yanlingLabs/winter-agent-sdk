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
  // P7a fix r1 (Minor-1): a MODEL-FACING description is a static string on a module-load
  // descriptor, so it cannot carry a session's dot-dir. Worded generically rather than left naming
  // a directory a reuser's product does not have -- the executor derives the real path from
  // `ctx.brand.projectDirName`.
  description: "name creates a temporary git worktree under the project's worktrees directory; path switches to a registered worktree under path rules. Changes session cwd + filesystem boundary.",
  exposure: "eager",
  permissionClass: "mode",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: [],
  disposition: "implement-now",
});
