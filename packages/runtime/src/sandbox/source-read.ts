import * as fs from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSymlinkEnds } from "../permissions/paths.ts";
import { assertHostCodePathAccess, hostCodePathAllowed, hostCodeProtectionGeneration, HostCodeProtectionError } from "./host-code-protection.ts";

// All source-derived reads share this boundary. There is deliberately no per-path bypass or
// exemption argument. Runtime control/durable stores use their separate fixed-authority readers.
const nativeReadPolicies = new Map<object, readonly string[]>();
// Filesystem provenance is private object identity, never a forgeable JSON field.
export interface SourceOrigin { readonly requested: string; readonly paths: readonly string[]; readonly canonical: string; }
const sourceObjects = new WeakMap<object, SourceOrigin>();
export function captureSourceOrigin(path: fs.PathLike | number): SourceOrigin {
  const requested = sourcePath(path), ends = resolveSymlinkEnds(requested);
  if (ends.chainTarget === undefined) throw new HostCodeProtectionError("source origin could not be resolved");
  let canonical = ends.chainTarget;
  try { canonical = fs.realpathSync(requested); } catch { /* missing sources keep their resolved spelling */ }
  return Object.freeze({ requested, canonical, paths: Object.freeze([...new Set([requested, ends.target, ends.chainTarget, canonical])]) });
}
export function assertSourceOrigin(origin: SourceOrigin): void { for (const path of origin.paths) assertSourceReadAccess(path); }
export function bindSourceObject<T extends object>(value: T, origin: string | SourceOrigin): T { sourceObjects.set(value, typeof origin === "string" ? captureSourceOrigin(origin) : origin); return value; }
export function inheritSourceObject<T extends object>(value: T, from: object, fallbackPath?: string): T {
  const origin = sourceObjects.get(from) ?? (fallbackPath === undefined ? undefined : captureSourceOrigin(fallbackPath));
  if (origin !== undefined) sourceObjects.set(value, origin);
  return value;
}
export function sourceObjectPath(value: object): string | undefined { return sourceObjects.get(value)?.requested; }
export function sourceObjectAllowed(value: object): boolean {
  const origin = sourceObjects.get(value);
  return origin === undefined || origin.paths.every(sourcePathAllowed);
}
let nativeGeneration = 0;
export function installSourceReadRestrictions(paths: readonly string[], cwd: string): () => void {
  const owner = {};
  const snapshot = Object.freeze(paths.map(path => isAbsolute(path) ? path : resolve(cwd, path)));
  nativeReadPolicies.set(owner, snapshot);
  nativeGeneration++;
  return () => { if (nativeReadPolicies.delete(owner)) nativeGeneration++; };
}
export function sourceReadRestrictionGeneration(): number { return nativeGeneration + hostCodeProtectionGeneration(); }
export function nativeSourceReadDenyPaths(): readonly string[] { return [...nativeReadPolicies.values()].flat(); }

function sourcePath(path: fs.PathLike | number): string {
  if (typeof path === "number") throw new HostCodeProtectionError("source reads require a path");
  const value = path instanceof URL ? fileURLToPath(path) : path.toString();
  return isAbsolute(value) ? value : resolve(value);
}
export function sourcePathAllowed(path: string): boolean {
  return hostCodePathAllowed(sourcePath(path), "read", {
    filesystem: { denyRead: [...nativeReadPolicies.values()].flat() },
  });
}
export function assertSourceReadAccess(path: fs.PathLike | number): void {
  assertHostCodePathAccess(sourcePath(path), "read", {
    filesystem: { denyRead: [...nativeReadPolicies.values()].flat() },
  });
}
/** Cached parsed values inherit this exact pre-I/O origin, rather than resolving an alias again. */
export function readSourceTextWithOrigin(path: string): { text: string; origin: SourceOrigin } {
  const origin = captureSourceOrigin(path); assertSourceOrigin(origin);
  const text = fs.readFileSync(origin.canonical, "utf8");
  assertSourceOrigin(origin);
  return { text, origin };
}
export const readSourceFileSync: typeof fs.readFileSync = ((path: fs.PathLike | number, options: unknown) => {
  const origin = captureSourceOrigin(path); assertSourceOrigin(origin);
  const result = (fs.readFileSync as (path: fs.PathLike | number, options: unknown) => string | Buffer)(origin.canonical, options);
  assertSourceOrigin(origin);
  return result;
}) as typeof fs.readFileSync;
export const readSourceDirectorySync: typeof fs.readdirSync = ((path: fs.PathLike, options: unknown) => {
  const origin = captureSourceOrigin(path); assertSourceOrigin(origin);
  const result = (fs.readdirSync as (path: fs.PathLike, options: unknown) => unknown)(origin.canonical, options);
  assertSourceOrigin(origin);
  return result;
}) as typeof fs.readdirSync;
export const statSourceSync: typeof fs.statSync = ((path, options) => {
  assertSourceReadAccess(path);
  return fs.statSync(path, options);
}) as typeof fs.statSync;
/** Only used for the bounded skill metadata prefix. The caller closes the returned descriptor. */
export const openSourceSync: typeof fs.openSync = ((path, flags, mode) => {
  const origin = captureSourceOrigin(path); assertSourceOrigin(origin);
  const fd = fs.openSync(origin.canonical, flags, mode);
  try { assertSourceOrigin(origin); } catch (error) { fs.closeSync(fd); throw error; }
  return fd;
}) as typeof fs.openSync;
export async function readSourceText(path: string): Promise<string> {
  const origin = captureSourceOrigin(path); assertSourceOrigin(origin);
  const result = await readFile(origin.canonical, "utf8");
  // A private host update can arrive while asynchronous I/O is pending. Discard denied bytes.
  assertSourceOrigin(origin);
  return result;
}
