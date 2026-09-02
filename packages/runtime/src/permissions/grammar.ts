// STUB -- Task 3 Step 1 (TDD RED). Real implementation lands in Step 2.
import type { PermissionMode as _PermissionMode } from "@yanlinglabs/winter-agent-sdk";

export type Specifier =
  | { kind: "wildcardAll" }
  | { kind: "pattern"; source: string }
  | { kind: "param"; field: string; value: string | boolean }
  | { kind: "webFetchDomain"; source: string }
  | { kind: "invalid"; reason: string };

export interface ParsedRule {
  toolName: string;
  specifier?: Specifier;
  isBareEquivalent: boolean;
}

export const PARSE_LIMIT = 50_000;
export const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set();

export function parseRule(_raw: string): ParsedRule {
  throw new Error("not implemented");
}

export function matchesRule(
  _rule: ParsedRule,
  _call: { toolName: string; input: Record<string, unknown> },
  _opts: { direction: "allow" | "denyAsk" },
): boolean {
  throw new Error("not implemented");
}

export function splitCompound(_command: string): string[] | null {
  throw new Error("not implemented");
}

export function stripWrappers(_cmd: string, _direction: "allow" | "denyAsk"): string {
  throw new Error("not implemented");
}

export function extractRedirectTargets(_command: string): string[] {
  throw new Error("not implemented");
}

export function isRecognizedReadOnly(_command: string): boolean {
  throw new Error("not implemented");
}
