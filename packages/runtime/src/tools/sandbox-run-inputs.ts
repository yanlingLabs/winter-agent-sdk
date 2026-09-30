// THE ONE BUILDER of the sandbox inputs every shell-running tool hands `runCommand` (sandbox/spawn.ts),
// which turns them into the seatbelt profile. Bash (foreground and background) and Monitor's command half
// used to build these separately -- "a small, deliberate duplication" -- and drifted: Monitor never
// passed `storeHome`, so under run homes (the daemon's normal setup, store home != winter home) its
// profile denied neither `<store>/file-history` nor `<store>/image-prep` and did not fence the store home
// against a rename, and a Monitor-sandboxed command could plant a link where `sips` writes. Every field
// the profile reads from the session comes from HERE now, so a new one reaches every tool at once
// (`sandbox-run-inputs.test.ts` pins that Bash and Monitor build identical inputs).
//
// Side-effect free (no tool registration), so both `impl/*` executors import it without registering
// each other's tools (impl-isolation.test.ts).
import type { ToolExecutionContext } from "./registry.ts";
import { splitDenyPathsByGlobShape, globDenyEntriesOf, type GlobDenyEntry } from "../permissions/file-rules.ts";
import type { SandboxBrand } from "../sandbox/profile.ts";

/** Everything about the SESSION the seatbelt profile needs, for any tool that runs a shell command. */
export interface SandboxRunInputs {
  cwd: string;
  env: NodeJS.ProcessEnv;
  settings: ToolExecutionContext["sandboxSettings"];
  writableRoots: string[];
  denyWritePaths?: string[];
  denyReadPaths?: string[];
  /** Fix round 11: glob-shaped denyWrite/denyRead entries, pre-converted to SBPL regex source -- see `splitDenyPathsByGlobShape`'s own header. */
  denyWriteRegexes?: string[];
  denyReadRegexes?: string[];
  /** Fix round 12: each glob-shaped denyWrite/denyRead entry's own canonicalized fixed-prefix directory -- feeds the ancestor-rename-bypass fix. */
  denyWriteGlobFixedPrefixes?: string[];
  denyReadGlobFixedPrefixes?: string[];
  /** Fix round 13: each glob-shaped denyRead entry, its regex PAIRED with its own fixed prefix -- feeds the read-deny-keep-in-place fix. */
  denyReadGlobEntries?: GlobDenyEntry[];
  home: string;
  /** Phase 5 fix wave, I1: the resolved winter root, distinct from the OS home above. */
  winterHome?: string;
  /** WS-21 fix round 1, item 4: the shared store home -- see `ToolExecutionContext.storeHome`. */
  storeHome?: string;
  /** P7a (D19): the session's brand -- the dot-dir names the seatbelt fences. */
  brand?: SandboxBrand;
  /** Fix round 16, item 2: `sandbox.filesystem.allowGitConfig` -- see `SandboxFilesystemSettings.allowGitConfig`'s own header. */
  allowGitConfigWrites?: boolean;
}

/**
 * Where a spawn may write: the session scratch dir, the session's bounded roots (the cwd among them),
 * the outputs dir when configured, and `filesystem.allowWrite` (WS-12 §12 Q5: additive, never a
 * replacement).
 */
export function computeWritableRoots(ctx: ToolExecutionContext): string[] {
  return [ctx.tempDir, ...ctx.session.getBoundedRoots(), ...(ctx.outDir !== undefined ? [ctx.outDir] : []), ...(ctx.sandboxSettings.filesystem?.allowWrite ?? [])];
}

/** The child's environment: this process's, with `TMPDIR` (and `OUTDIR` when configured) pointed at the session's own dirs. */
export function buildSandboxChildEnv(ctx: ToolExecutionContext): NodeJS.ProcessEnv {
  return { ...process.env, TMPDIR: ctx.tempDir, ...(ctx.outDir !== undefined ? { OUTDIR: ctx.outDir } : {}) };
}

/** `filesystem.denyWrite`/`denyRead`, split into plain paths and glob-shaped regexes (C1 / fix rounds 11-13). */
export function computeDenyPaths(ctx: ToolExecutionContext): Pick<SandboxRunInputs, "denyWritePaths" | "denyReadPaths" | "denyWriteRegexes" | "denyReadRegexes" | "denyWriteGlobFixedPrefixes" | "denyReadGlobFixedPrefixes" | "denyReadGlobEntries"> {
  const fs = ctx.sandboxSettings.filesystem;
  const write = splitDenyPathsByGlobShape(fs?.denyWrite ?? []);
  const read = splitDenyPathsByGlobShape(fs?.denyRead ?? []);
  const readGlobEntries = globDenyEntriesOf(fs?.denyRead ?? []);
  return {
    ...(write.paths.length > 0 ? { denyWritePaths: write.paths } : {}),
    ...(read.paths.length > 0 ? { denyReadPaths: read.paths } : {}),
    ...(write.regexes.length > 0 ? { denyWriteRegexes: write.regexes } : {}),
    ...(read.regexes.length > 0 ? { denyReadRegexes: read.regexes } : {}),
    ...(write.globFixedPrefixes.length > 0 ? { denyWriteGlobFixedPrefixes: write.globFixedPrefixes } : {}),
    ...(read.globFixedPrefixes.length > 0 ? { denyReadGlobFixedPrefixes: read.globFixedPrefixes } : {}),
    ...(readGlobEntries.length > 0 ? { denyReadGlobEntries: readGlobEntries } : {}),
  };
}

/** The session's sandbox inputs, identical for every tool that runs a shell command. */
export function sandboxRunInputs(ctx: ToolExecutionContext): SandboxRunInputs {
  return {
    cwd: ctx.cwd,
    env: buildSandboxChildEnv(ctx),
    settings: ctx.sandboxSettings,
    writableRoots: computeWritableRoots(ctx),
    ...computeDenyPaths(ctx),
    home: ctx.home,
    ...(ctx.winterHome !== undefined ? { winterHome: ctx.winterHome } : {}),
    ...(ctx.storeHome !== undefined ? { storeHome: ctx.storeHome } : {}),
    ...(ctx.brand !== undefined ? { brand: ctx.brand } : {}),
    ...(ctx.sandboxSettings.filesystem?.allowGitConfig !== undefined ? { allowGitConfigWrites: ctx.sandboxSettings.filesystem.allowGitConfig } : {}),
  };
}
