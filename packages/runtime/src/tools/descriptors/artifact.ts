// WS-06 §3.2 "Artifact" -- correctly-absent (v1), declared. Full declared action union pinned so
// permission rules and drift gates recognize the name; requires claude.ai hosting + subscription
// login, off by default in API-key SDK runs. A future Winter publishing backend MAY implement the
// same action surface (winter-backed-later candidate, product decision -- §3.2's own note); that is
// NOT this v1 disposition.
import { stub } from "./_shared.ts";

stub({
  canonicalName: "Artifact",
  advertisedName: "Artifact",
  source: "host",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["publish", "list", "read", "watch", "unwatch", "status", "upload_asset", "list_assets", "read_asset", "delete_asset"],
      },
      file_path: { type: "string" },
      favicon: { type: "string" },
      limit: { type: "number" },
      scope: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      label: { type: "string" },
      note: { type: "string" },
      url: { type: "string" },
      prompt: { type: "string" },
      force: { type: "boolean" },
      out_dir: { type: "string" },
      asset_id: { type: "string" },
      after: { type: "string" },
      capabilities: { type: "object" },
      contract: { type: "string" },
    },
  },
  description: "Publishes/manages hosted Artifacts. Requires claude.ai hosting and subscription login; off by default in API-key SDK runs.",
  exposure: "hidden",
  permissionClass: "hosted",
  availability: {},
  capabilityRequirements: ["claude.ai-hosting"],
  disposition: "correctly-absent",
});
