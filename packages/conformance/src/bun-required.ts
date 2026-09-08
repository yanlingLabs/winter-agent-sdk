// P7a fix wave round 2 (item 3; re-review N1): THE BUN-ONLY DOOR, MADE TYPED.
//
// `engines.node` on this package means IMPORTABLE UNDER NODE. It does not mean every exported
// function runs there, and the compiled emit made that distinction load-bearing rather than
// theoretical: before it, a Node consumer failed at `import` and never reached a function at all.
// Now the import succeeds, so a Node consumer CAN call `runCapture` — and what they got was
// `ReferenceError: Bun is not defined` from inside `capture.ts`, which reads as a bug in this
// package rather than as a documented limit of the function they chose.
//
// So the limit is stated where it is enforced: one typed error, thrown at the ENTRY POINT of each
// Bun-only path reachable from a published barrel, naming the function, the Bun API it needs, and
// what a Node caller should do instead. `BunRequiredError` is exported from this package's own
// barrel so a consumer can `catch` it by identity rather than by matching a message.
//
// WHY IT IS DUPLICATED FROM `@yanlinglabs/winter-provider-runtime`. This package has NO dependencies
// at all (`"dependencies": {}` — deliberately: it is the drop-in-surface conformance harness), so
// there is no module both packages can already reach, and adding a dependency edge to share one
// eight-line class would be the larger change. The two copies are byte-identical apart from this
// paragraph and the examples below; a consumer catching one is not catching the other, which is
// correct — they are different packages' limits.

/**
 * A function that needs the Bun runtime was called somewhere else.
 *
 * `name` is the exported function the caller actually invoked (never the internal helper that
 * reaches for Bun), because that is the name in their code.
 */
export class BunRequiredError extends Error {
  readonly name = "BunRequiredError";
  /** The exported function the caller invoked. */
  readonly functionName: string;
  /** The Bun API that has no Node equivalent this package implements, e.g. `Bun.serve`. */
  readonly bunApi: string;

  constructor(functionName: string, bunApi: string, detail: string) {
    super(`${functionName}() requires the Bun runtime: it uses ${bunApi}, which has no Node equivalent this package implements. ${detail}`);
    this.functionName = functionName;
    this.bunApi = bunApi;
  }
}

/** True when this process is Bun. Separated so a test can assert the guard without a subprocess. */
export function hasBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

/**
 * Throws `BunRequiredError` unless this process is Bun. Called FIRST in each guarded function, before
 * any network call, any file write and any credential read — a guard that fired after a side effect
 * would be a worse failure than the `ReferenceError` it replaces.
 */
export function requireBunRuntime(functionName: string, bunApi: string, detail: string): void {
  if (!hasBunRuntime()) throw new BunRequiredError(functionName, bunApi, detail);
}
