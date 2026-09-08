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
/**
 * P7a fix wave round 3 (F2): CROSS-BUNDLE `instanceof`.
 *
 * THE PROBLEM, measured on the compiled emit under Node. `build-packages.ts` runs `bun build` ONCE
 * PER EXPORT ENTRY, so every entry bundle carries its own copy of every internal module: the class
 * declared in one source file exists as TWO DISTINCT CLASSES at runtime, one in `dist/index.js` and
 * one in `dist/<subpath>/index.js`. A consumer who imports the function from one subpath and the
 * class from the other -- the pattern both new READMEs teach -- gets a silent `false` from
 * `instanceof` and rethrows the very error the guard exists to make catchable. Under Bun the `bun`
 * condition resolves both entries to the same `src/*.ts`, so the classes ARE identical, which is why
 * no Bun-side test could see it.
 *
 * THE FIX, applied to the CLASS of the problem rather than to one error: every error class exported
 * from more than one subpath of a package carries a PACKAGE-SCOPED `Symbol.for(...)` brand and a
 * `static [Symbol.hasInstance]` that tests for it. `Symbol.for` is cross-realm and cross-copy, so
 * every duplicated bundle of ONE package agrees -- while a DIFFERENT package's class, whose key
 * names a different package, still does not match. The two packages stay deliberately distinct
 * (they share no dependency and cannot share a module), and the existing distinctness test passes
 * unchanged.
 *
 * Considered and recorded as a carry rather than done here: `bun build --splitting`, so shared
 * internals emit once per package. It is the more fundamental answer and it changes the emit shape
 * for every package and every `.d.ts` -- not a round-3-sized change.
 */
export function brandedInstanceOf(brand: symbol) {
  return (candidate: unknown): boolean => typeof candidate === "object" && candidate !== null && brand in (candidate as object);
}

/** The cross-bundle identity of THIS package's `BunRequiredError`. Package-scoped on purpose. */
const BUN_REQUIRED_BRAND = Symbol.for("@yanlinglabs/winter-conformance:BunRequiredError");

export class BunRequiredError extends Error {
  readonly name = "BunRequiredError";
  /** F2: the brand `Symbol.hasInstance` below tests for. Present on every instance, in every bundle. */
  readonly [BUN_REQUIRED_BRAND] = true;
  /** F2: `instanceof` holds across this package's duplicated entry bundles, and only this package's. */
  static [Symbol.hasInstance] = brandedInstanceOf(BUN_REQUIRED_BRAND);
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
