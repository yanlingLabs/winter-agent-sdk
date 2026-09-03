// WS-06 §3.2 "SendUserFile" -- winter-backed-later, runtime-derived, verbatim schema. Requires a
// compatible remote client + file-delivery infrastructure; implemented verbatim once [WS-15] ships
// a Winter file-delivery transport. Absent until then.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "SendUserFile",
  advertisedName: "SendUserFile",
  source: "host",
  inputSchema: {
    type: "object",
    properties: {
      files: { type: "array", items: { type: "string" }, minItems: 1 },
      caption: { type: "string" },
      status: { type: "string", enum: ["normal", "proactive"] },
      display: { type: "string", enum: ["render", "attach"] },
    },
    required: ["files", "status"],
  },
  description: "Delivers files to a compatible remote client. Requires Winter's own file-delivery transport ([WS-15]) -- absent until that backend exists.",
  // "hosted"/absent-until-backend does NOT mean exposure:"hidden" -- §1.2 Set 3's own definition
  // ("advertised only when their gate holds") is exactly what capabilityRequirements below already
  // enforces; exposure:"hidden" would keep this out of the advertised set even once a real Winter
  // transport DID exist. `exposure: "hidden"` is reserved for correctly-absent tools only.
  exposure: "eager",
  permissionClass: "hosted",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: ["winter.file-delivery-transport"],
  disposition: "winter-backed-later",
});
