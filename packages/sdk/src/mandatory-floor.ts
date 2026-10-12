import { existsSync } from "node:fs";
import { dirname, isAbsolute, normalize } from "node:path";
import type { SpawnClaudeCodeProcess, SpawnRuntimeOptions } from "./transport.ts";

export const MANDATORY_FLOOR_CONTRACT_VERSION = 1;
export const HOST_EXECUTION_FLOOR_CAPABILITY = "macos-persistent-control-floor-v1";
/** Host-owned registration data. NEVER read this from project settings or a model tool argument. */
export interface HostExecutionFloor {
  /** Canonical host paths plus admitted aliases, prepared by the host registration owner. */
  denyReadPaths: readonly string[];
  denyWritePaths: readonly string[];
  denyReadRegexes?: readonly string[];
  denyWriteRegexes?: readonly string[];
  denyReadGlobs?: readonly string[];
  denyWriteGlobs?: readonly string[];
  denyLinkPaths?: readonly string[];
  protectAncestorsOf?: readonly string[];
}
export class MandatoryFloorUnavailableError extends Error {
  readonly code = "mandatory_floor_unavailable";
  constructor(message: string) { super(message); this.name = "MandatoryFloorUnavailableError"; }
}
function safeText(value: string): string {
  if (typeof value !== "string" || /[\0\r\n]/.test(value)) throw new MandatoryFloorUnavailableError("invalid host floor text");
  return value;
}
function safePath(value: string): string {
  safeText(value);
  if (!isAbsolute(value) || normalize(value) !== value || value === "/") throw new MandatoryFloorUnavailableError("host floor paths must be canonical absolute paths below root");
  return value;
}
const quoted = (value: string) => `"${safeText(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const regexClause = (value: string) => `(regex #"${safeText(value).replace(/"/g, '\\"')}")`;
const pathClause = (value: string) => `(subpath ${quoted(safePath(value))})`;
function globRegex(value: string): string {
  safeText(value);
  if (!value.startsWith("/")) throw new MandatoryFloorUnavailableError("host floor globs must be absolute");
  let result = "^";
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (c === "*") {
      if (value[i+1] === "*") {
        i++;
        if (value[i+1] === "/") { i++; result += "(?:.*/)?"; }
        else result += ".*";
      } else result += "[^/]*";
    } else if (c === "?") result += "[^/]";
    else if (c === "[" || c === "]" || c === "{" || c === "}") throw new MandatoryFloorUnavailableError("unsupported host floor glob syntax");
    else result += /[\\^$.|+()]/.test(c) ? `\\${c}` : c;
  }
  return result + "$";
}
function copyFloor(floor: HostExecutionFloor): HostExecutionFloor {
  const result: HostExecutionFloor = { denyReadPaths: [...floor.denyReadPaths], denyWritePaths: [...floor.denyWritePaths] };
  for (const key of ["denyReadRegexes", "denyWriteRegexes", "denyReadGlobs", "denyWriteGlobs", "denyLinkPaths", "protectAncestorsOf"] as const) if (floor[key] !== undefined) result[key] = [...floor[key]!];
  for (const array of Object.values(result)) Object.freeze(array);
  return Object.freeze(result);
}
export function hasMandatoryFloor(floor: HostExecutionFloor): boolean {
  return Object.values(floor).some((entries: readonly string[]) => entries.length > 0);
}
/** Minimal persistent floor: all unrelated operations remain allowed. No ordinary Code policy here. */
export function buildMandatoryFloorProfile(floor: HostExecutionFloor): string {
  const read = [...floor.denyReadPaths.map(pathClause), ...(floor.denyReadRegexes ?? []).map(regexClause), ...(floor.denyReadGlobs ?? []).map((value) => regexClause(globRegex(value)))];
  const write = [...floor.denyWritePaths.map(pathClause), ...(floor.denyWriteRegexes ?? []).map(regexClause), ...(floor.denyWriteGlobs ?? []).map((value) => regexClause(globRegex(value)))];
  const link = [...new Set([...floor.denyWritePaths, ...floor.denyReadPaths, ...(floor.denyLinkPaths ?? [])])].map(pathClause);
  // Regex/glob-protected entries also cannot be linked to an unrestricted spelling.
  link.push(...read.filter((value) => value.startsWith("(regex")), ...write.filter((value) => value.startsWith("(regex")));
  const ancestors = new Set<string>();
  for (const entry of [...floor.denyWritePaths, ...floor.denyReadPaths, ...(floor.protectAncestorsOf ?? [])]) {
    let current = dirname(safePath(entry));
    while (current !== "/") { ancestors.add(current); current = dirname(current); }
  }
  return ["(version 1)", "(allow default)",
    ...read.map((filter) => `(deny file-read* file-read-data file-read-metadata ${filter})`),
    ...write.map((filter) => `(deny file-write* file-write-data file-write-mode file-write-owner file-write-unlink file-write-create ${filter})`),
    ...link.map((filter) => `(deny file-link ${filter})`),
    ...[...ancestors].map((path) => `(deny file-write-unlink file-write-create file-write-mode file-write-owner (literal ${quoted(path)}))`),
  ].join("\n");
}
/** Apply AFTER the existing host hook has resolved its executable, immediately before OS spawn. */
export function applyMandatoryFloorToSpawnOptions(resolved: SpawnRuntimeOptions, floor?: HostExecutionFloor): SpawnRuntimeOptions {
  if (resolved.requireHostFloor && (!floor || !hasMandatoryFloor(floor))) throw new MandatoryFloorUnavailableError("required host floor has no registered paths; refusing unprotected process creation");
  if (!floor || !hasMandatoryFloor(floor)) return resolved;
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) throw new MandatoryFloorUnavailableError("registered host control floor requires macOS sandbox-exec; refusing unprotected process creation");
  if (!isAbsolute(resolved.command)) throw new MandatoryFloorUnavailableError("resolve the runtime executable before applying the host floor");
  const configAt = resolved.args.indexOf("--config-json");
  if (configAt !== -1) {
    let config: { hostCodeProcessBroker?: { generationId?: unknown }; executionPosture?: unknown };
    try { config = JSON.parse(resolved.args[configAt+1] ?? "") as typeof config; } catch { throw new MandatoryFloorUnavailableError("invalid runtime config behind host floor"); }
    if (config.executionPosture === "confined-guest" || typeof config.hostCodeProcessBroker?.generationId !== "string") throw new MandatoryFloorUnavailableError("enrolling a Code runtime in the floor requires its trusted-parent process broker");
  }
  const profile = buildMandatoryFloorProfile(floor);
  return { ...resolved, requireHostFloor: true, command: "/usr/bin/sandbox-exec", args: ["-p", profile, resolved.command, ...resolved.args] };
}
/** The runtime and all descendants inherit this floor; excluded/override shell settings cannot remove it.
 * Existing unwrapped generations MUST be drained/recreated before registration becomes usable. */
export function createMandatoryFloorSpawn(input: { spawn: SpawnClaudeCodeProcess; floor?: HostExecutionFloor; requireHostFloor?: boolean }): SpawnClaudeCodeProcess {
  const floor = input.floor === undefined ? undefined : copyFloor(input.floor);
  if (input.requireHostFloor && (!floor || !hasMandatoryFloor(floor))) throw new MandatoryFloorUnavailableError("required host floor has no registered paths; refusing unprotected process creation");
  return (resolved) => input.spawn(applyMandatoryFloorToSpawnOptions(resolved, floor));
}
