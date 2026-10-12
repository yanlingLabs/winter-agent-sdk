import { isAbsolute, normalize, resolve } from "node:path";
import { splitDenyPathsByGlobShape } from "../permissions/file-rules.ts";
import { resolveSymlinkEnds } from "../permissions/paths.ts";
import type { SandboxSettings } from "./profile.ts";

/** Host-owned path policy, not an execution floor. Does not wrap approved escapes or third-party
 * subprocesses. NEVER construct from RuntimeConfig, settings, environment or model arguments. */
export interface HostCodeProtection {
  revision: number;
  denyReadPaths: readonly string[];
  denyWritePaths: readonly string[];
}
export class HostCodeProtectionError extends Error {
  readonly code = "host_code_path_denied";
  constructor(message: string) { super(message); this.name = "HostCodeProtectionError"; }
}
export function copyHostCodeProtection(value: HostCodeProtection): Readonly<HostCodeProtection> {
  if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new HostCodeProtectionError("invalid host path-policy revision");
  const copy = (paths: readonly string[]) => {
    if (!Array.isArray(paths) || paths.length > 4096) throw new HostCodeProtectionError("invalid host path-policy bounds");
    for (const path of paths) if (typeof path !== "string" || !isAbsolute(path) || path === "/" || path.length > 8192 || /[\0\r\n]/.test(path) || normalize(path) !== path) throw new HostCodeProtectionError("invalid host path-policy path");
    // Validate glob syntax before publishing a new snapshot.
    for (const regex of splitDenyPathsByGlobShape(paths).regexes) new RegExp(regex);
    return Object.freeze([...new Set(paths)]);
  };
  return Object.freeze({ revision: value.revision, denyReadPaths: copy(value.denyReadPaths), denyWritePaths: copy(value.denyWritePaths) });
}
const owners = new Map<object, Readonly<HostCodeProtection>>();
export interface HostCodeProtectionLease {
  update(value: HostCodeProtection): number;
  close(): void;
}
export function installHostCodeProtection(value: HostCodeProtection): HostCodeProtectionLease {
  const owner = {}, initial = copyHostCodeProtection(value);
  owners.set(owner, initial);
  return Object.freeze({
    update(value: HostCodeProtection) {
      const previous = owners.get(owner);
      if (!previous) throw new HostCodeProtectionError("host path-policy owner is closed");
      const next = copyHostCodeProtection(value);
      if (next.revision < previous.revision || (next.revision === previous.revision && JSON.stringify(next) !== JSON.stringify(previous))) throw new HostCodeProtectionError("stale or conflicting host path-policy revision");
      owners.set(owner, next); return next.revision;
    },
    close() { owners.delete(owner); },
  });
}
export function currentHostCodeProtectionPaths(): Pick<HostCodeProtection, "denyReadPaths" | "denyWritePaths"> {
  return { denyReadPaths: [...new Set([...owners.values()].flatMap(value => [...value.denyReadPaths]))], denyWritePaths: [...new Set([...owners.values()].flatMap(value => [...value.denyWritePaths]))] };
}
/** Canonical spelling/symlink checks for SDK tool operations. Defense in depth: does not prevent
 * arbitrary same-user access, hardlink aliases or an external race after this synchronous check. */
export function hostCodePathAllowed(path: string, access: "read" | "write", settings?: SandboxSettings, cwd = "/"): boolean {
  const active = currentHostCodeProtectionPaths();
  const paths = [...active[access === "read" ? "denyReadPaths" : "denyWritePaths"], ...(settings?.filesystem?.[access === "read" ? "denyRead" : "denyWrite"] ?? []).map(path => isAbsolute(path) ? path : resolve(cwd, path))];
  if (!paths.length) return true;
  try {
    if (!isAbsolute(path) || /[\0\r\n]/.test(path)) return false;
    const ends = resolveSymlinkEnds(normalize(path));
    if (ends.chainTarget === undefined) return false;
    const candidates = [normalize(path), ends.target, ends.chainTarget];
    const split = splitDenyPathsByGlobShape(paths);
    const fold = (value: string) => process.platform === "darwin" ? value.toLowerCase() : value;
    // Also match the original literal spelling. A reserved host directory may contain bracket
    // or wildcard characters; interpreting those as a glob must not lose its actual subtree.
    for (const denied of [...new Set([...paths, ...split.paths])]) {
      const roots = resolveSymlinkEnds(denied);
      for (const root of [denied, roots.target, roots.chainTarget].filter((value): value is string => value !== undefined)) {
        const target = fold(root);
        if (candidates.some(value => fold(value) === target || target === "/" || fold(value).startsWith(target + "/"))) return false;
      }
    }
    for (const source of split.regexes) if (candidates.some(value => new RegExp(source, process.platform === "darwin" ? "i" : "").test(value))) return false;
    return true;
  } catch { return false; }
}
export function assertHostCodePathAccess(path: string, access: "read" | "write", settings?: SandboxSettings, cwd?: string): void {
  if (!hostCodePathAllowed(path, access, settings, cwd)) throw new HostCodeProtectionError("protected host path access refused");
}
