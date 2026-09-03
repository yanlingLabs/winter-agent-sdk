// WS-06 §3.6 "REPL" -- implement-later (feature-gated internal; not in the public table). Gated on
// a not-yet-satisfiable capability token so it stays honestly unavailable until a real backend
// exists, mirroring the winter-backed-later tools' own pattern.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "REPL",
  advertisedName: "REPL",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      code: { type: "string" },
      description: { type: "string" },
      timeout: { type: "number" },
    },
    required: ["code"],
  },
  description: "Persistent-state JS, top-level await; can register/call inner tools. Feature-gated internal, not in the public table.",
  // §1.2 Set 3's own definition ("advertised only when their gate holds") is what
  // capabilityRequirements below already enforces -- exposure:"hidden" is reserved for
  // correctly-absent tools, which REPL is not (see send-user-file.ts's identical note).
  exposure: "eager",
  permissionClass: "execute",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: ["winter.repl-backend"],
  disposition: "implement-later",
});
