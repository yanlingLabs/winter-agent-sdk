/** Closed disposable fixture cases. No model-supplied policy, shell, path or native admission. */
export const CASES = ["ask-allow", "ask-deny", "plan", "bypass"] as const;
export type Case = typeof CASES[number];
export function fixtureCase(value: unknown): Case {
  if (!(CASES as readonly unknown[]).includes(value)) throw new Error("fixture case unavailable");
  return value as Case;
}
/** Builtins only: current restricted tool skeleton does not claim the utility-device profile. */
export function boundaryCommand(kind: Case): string {
  return [
    'test "$UID" = 10001',
    'test ! -e /workspace/.winter/conversations',
    'test ! -e /run/winter/conversations',
    'test ! -e /outside-source',
    'test -L store-probe && test ! -e store-probe',
    'test -L credential-probe && test ! -e credential-probe',
    'test ! -e /host-only-credential',
    'test ! -e /winter-runtime',
    'test ! -e /dev',
    'test ! -e /proc',
    'test ! -e /run/winter',
    'test ! -e /workspace/.winter',
    'for envkey in OPENAI_API_KEY ANTHROPIC_API_KEY WINTER_TEST_KEYCHAIN_SECRET; do test -z "${!envkey-}" || exit 34; done',
    'printf host-query-boundary-ok',
  ].join(' && ');
}
export function toolScript(kind: Case) {
  const script: { name: string; input: Record<string, unknown> }[] = [
    { name: "Read", input: { file_path: "seed" } },
    { name: "Write", input: { file_path: "approved-write", content: "approved\n" } },
    { name: "Bash", input: { command: boundaryCommand(kind), timeout: 5000 } },
  ];
  if (kind === "bypass") script.push(
    { name: "Read", input: { file_path: "store-probe/hidden" } },
    { name: "Write", input: { file_path: "/outside-source", content: "must-not-write" } },
    { name: "Read", input: { file_path: "credential-probe" } },
  );
  return script;
}
export const terminalText = (kind: Case) => `host-query-${kind}-complete`;
