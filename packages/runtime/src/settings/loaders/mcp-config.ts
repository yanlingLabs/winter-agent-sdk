// Phase 5 Lane S: the MCP CONFIG LOADERS -- the project `mcp.json` and `Settings.mcpServers`.
//
// THESE PRODUCE INPUT AND NOTHING ELSE. `mcp/lifecycle.ts`'s `resolveMcpServerSources` is the
// authority on validation, precedence, duplicate reporting, the reserved `winter` name and the
// trust gate; its own header states outright that "WHERE the project `mcp.json`/settings actually
// get read from disk, and HOW workspace trust is computed, are integration concerns for whoever
// assembles `McpServerSource[]`". This module is that assembler. It computes no trust, validates no
// server config and connects to nothing.
//
// "TRUST-FLAGGED" MEANS THE ORIGIN TAG. The trust gate lives in `resolveMcpServerSources` and fires
// on `origin === "project"` for EVERY transport (RULING P5-K, fix wave -- it was stdio-only through
// P4, when only process spawning looked dangerous). So the only thing a loader can get wrong about
// trust is which ORIGIN it tags a source with -- and that is exactly the judgment call below.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { WINTER_BRAND, type BrandProfile, type ResolvedSettingSource, type SettingSource } from "@yanlinglabs/winter-agent-sdk";
import type { McpConfigSourceOrigin, McpServerSource } from "../../mcp/lifecycle.ts";

/**
 * WS-01 §2.4: the native project MCP config, under `brand.projectDirName`. The official branch's
 * `.mcp.json` is NOT read.
 */
export function projectMcpConfigRelative(brand?: Pick<BrandProfile, "projectDirName">): string {
  return join((brand ?? WINTER_BRAND).projectDirName, "mcp.json");
}

/** Winter's own value, for every caller that has not threaded a brand. */
export const PROJECT_MCP_CONFIG_RELATIVE = projectMcpConfigRelative();

export interface RejectedMcpConfig {
  origin: McpConfigSourceOrigin;
  path?: string;
  reason: string;
}

export interface McpConfigLoadResult {
  sources: McpServerSource[];
  rejected: RejectedMcpConfig[];
}

/** One settings tier's contribution -- the same input shape `buildHookEntriesFromSettings` accepts. */
export interface SettingsMcpSourceInput {
  source: ResolvedSettingSource;
  path?: string;
  settings?: { mcpServers?: unknown; [key: string]: unknown };
  values?: { mcpServers?: unknown; [key: string]: unknown };
  policyOrigin?: string;
  loaded?: boolean;
  error?: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Both shapes: a `{ mcpServers: {...} }` wrapper and a bare name->config map. */
function serversFrom(parsed: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(parsed)) return undefined;
  const wrapped = parsed["mcpServers"];
  if (wrapped !== undefined) return isPlainObject(wrapped) ? wrapped : undefined;
  return parsed;
}

function sourcesAllow(settingSources: SettingSource[] | undefined, tier: SettingSource): boolean {
  return settingSources === undefined || settingSources.includes(tier);
}

/**
 * `<cwd>/.winter/mcp.json`.
 *
 * SOURCE-GATED on `project ∈ settingSources`, exactly like project skills and commands: WS-01 §2.4
 * has the official branch run with `settingSources: []` and get its servers "via explicit
 * `mcpServers` options only", which is only true if this file is not read in that mode.
 *
 * NO PARENT-WALK, unlike skills. The project `mcp.json` names PROCESSES to run, and a walk would let a
 * config committed several directories above the session's cwd start a stdio server the user never
 * looked at. The skills walk carries no such authority. Disclosed divergence from the skill tier.
 */
export function loadProjectMcpConfig(opts: { cwd: string; settingSources?: SettingSource[] | undefined; brand?: Pick<BrandProfile, "projectDirName"> }): McpConfigLoadResult {
  if (!sourcesAllow(opts.settingSources, "project")) return { sources: [], rejected: [] };
  const path = join(opts.cwd, projectMcpConfigRelative(opts.brand));
  let raw: string;
  try {
    if (!statSync(path).isFile()) return { sources: [], rejected: [] };
    raw = readFileSync(path, "utf8");
  } catch {
    return { sources: [], rejected: [] }; // absent -- not a rejection
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { sources: [], rejected: [{ origin: "project", path, reason: `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  const servers = serversFrom(parsed);
  if (servers === undefined) {
    return { sources: [], rejected: [{ origin: "project", path, reason: `${path} must contain an object of MCP server configs, optionally wrapped in "mcpServers"` }] };
  }
  return { sources: [{ origin: "project", servers }], rejected: [] };
}

/**
 * WHICH ORIGIN A SETTINGS TIER'S `mcpServers` BLOCK GETS -- a disclosed judgment call.
 *
 * WS-09 §1.2's precedence table ranks `settings` above `project`, where `project` is the ambient
 * the project `mcp.json`. Read literally, EVERY settings tier would be `settings` -- and a
 * repo-committed project `settings.json` would then connect a server in an untrusted clone, because
 * the trust gate only fires on `origin === "project"`. That is the same self-grant shape P5-A closes
 * on the permission side, arriving through a different file.
 *
 * So the PROJECT tier maps to `project` (gated) and every other tier to `settings` (ungated):
 * `local` is gitignored and personal and carries user authority under P5-A's own reading, `user` is
 * the user's own file, and `managed`/`flag` are policy and host configuration. The cost is that a
 * project settings.json ranks below a user one rather than between it and `.mcp.json` -- a
 * precedence nuance -- and the alternative cost is connecting a repository's server declaration in
 * an untrusted checkout (a process for stdio; a remote tool surface the model calls with
 * conversation-derived arguments for http/sse -- RULING P5-K's own reasoning).
 */
const ORIGIN_BY_SETTING_SOURCE: Record<ResolvedSettingSource, McpConfigSourceOrigin> = {
  managed: "settings",
  flag: "settings",
  user: "settings",
  local: "settings",
  project: "project",
};

/**
 * `Settings.mcpServers` from every loaded tier.
 *
 * ORDER: the caller's tier order is preserved, and `resolveMcpServerSources` processes by ORIGIN
 * first, so ordering within an origin is all this controls. Pass the tiers highest-precedence first
 * (which is the order `resolveSettingsDetailed` already returns them in), and pass this result
 * BEFORE `loadProjectMcpConfig`'s so a project settings.json entry outranks the ambient
 * the project `mcp.json` while still sharing its gate.
 */
export function settingsMcpServerSources(perSource: readonly SettingsMcpSourceInput[] | undefined): McpConfigLoadResult {
  const sources: McpServerSource[] = [];
  const rejected: RejectedMcpConfig[] = [];
  for (const tier of perSource ?? []) {
    const block = (tier.settings ?? tier.values)?.["mcpServers"];
    if (block === undefined) continue; // no block at all -- not a rejection
    const origin = ORIGIN_BY_SETTING_SOURCE[tier.source];
    if (!isPlainObject(block)) {
      rejected.push({ origin, ...(tier.path !== undefined ? { path: tier.path } : {}), reason: `expected an object for "mcpServers", got ${Array.isArray(block) ? "an array" : typeof block}` });
      continue;
    }
    sources.push({ origin, servers: block });
  }
  return { sources, rejected };
}
