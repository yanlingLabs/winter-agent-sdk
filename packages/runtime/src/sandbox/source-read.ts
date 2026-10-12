import * as fs from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertHostCodePathAccess, hostCodePathAllowed, hostCodeProtectionGeneration, HostCodeProtectionError } from "./host-code-protection.ts";

// All source-derived reads share this boundary. There is deliberately no per-path bypass or
// exemption argument. Runtime control/durable stores use their separate fixed-authority readers.
const nativeReadPolicies = new Map<object, readonly string[]>();
// Filesystem provenance is private object identity, never a forgeable JSON field.
const sourceObjects = new WeakMap<object, string>();
export function bindSourceObject<T extends object>(value: T, path: string): T { sourceObjects.set(value, sourcePath(path)); return value; }
export function sourceObjectAllowed(value: object): boolean {
  const path = sourceObjects.get(value);
  return path === undefined || sourcePathAllowed(path);
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
export const readSourceFileSync: typeof fs.readFileSync = ((path: fs.PathLike | number, options: unknown) => {
  assertSourceReadAccess(path);
  const result = (fs.readFileSync as (path: fs.PathLike | number, options: unknown) => string | Buffer)(path, options);
  assertSourceReadAccess(path);
  return result;
}) as typeof fs.readFileSync;
export const readSourceDirectorySync: typeof fs.readdirSync = ((path: fs.PathLike, options: unknown) => {
  assertSourceReadAccess(path);
  const result = (fs.readdirSync as (path: fs.PathLike, options: unknown) => unknown)(path, options);
  assertSourceReadAccess(path);
  return result;
}) as typeof fs.readdirSync;
export const statSourceSync: typeof fs.statSync = ((path, options) => {
  assertSourceReadAccess(path);
  return fs.statSync(path, options);
}) as typeof fs.statSync;
/** Only used for the bounded skill metadata prefix. The caller closes the returned descriptor. */
export const openSourceSync: typeof fs.openSync = ((path, flags, mode) => {
  assertSourceReadAccess(path);
  const fd = fs.openSync(path, flags, mode);
  try { assertSourceReadAccess(path); } catch (error) { fs.closeSync(fd); throw error; }
  return fd;
}) as typeof fs.openSync;
export async function readSourceText(path: string): Promise<string> {
  assertSourceReadAccess(path);
  const result = await readFile(path, "utf8");
  // A private host update can arrive while asynchronous I/O is pending. Discard denied bytes.
  assertSourceReadAccess(path);
  return result;
}
