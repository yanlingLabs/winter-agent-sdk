// RED-phase stub (Task 4, WS-07 §3.1) -- signatures only, thrown/trivial bodies so paths.test.ts
// exercises real call sites (not module-resolution errors) before the real implementation lands.
import type { PermissionBehavior } from "@yanlinglabs/winter-agent-sdk";

export interface MatchFileRuleOptions {
  path: string;
  cwd: string;
  sourceDir?: string;
  home: string;
  direction: "allow" | "denyAsk";
}

export function matchFileRule(_pattern: string, _opts: MatchFileRuleOptions): boolean {
  throw new Error("not implemented");
}

export interface SymlinkBothEndsResult {
  allowRequiresBoth: boolean;
  denyIfEither: boolean;
}

export function checkSymlinkBothEnds(
  _path: string,
  _matcher: (candidatePath: string) => boolean,
): SymlinkBothEndsResult {
  throw new Error("not implemented");
}

export interface FileRuleEntry {
  toolName: string;
  pattern: string;
  behavior: PermissionBehavior;
  sourceDir?: string;
}

export function readDenyBlocksEdit(
  _rules: FileRuleEntry[],
  _path: string,
  _ctx: { cwd: string; home: string },
): boolean {
  throw new Error("not implemented");
}
