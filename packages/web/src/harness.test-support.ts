// The test API both runtimes run: `bun:test` under Bun, `node:test` under Node, behind one small
// surface (`describe`, `test`, `before`, `after`, each optionally `{ skip }`). Bun's own node:test
// layer cannot run one file's suite hooks next to another file's suites in the same process, which
// is how `bun test` runs a directory -- so under Bun the native API is used. Assertions are
// `node:assert/strict` everywhere.
type Body = () => void | Promise<void>;
type Options = { skip?: string | false };

interface Api {
  describe(name: string, fn: () => void): void;
  test(name: string, fn: Body, timeoutMs?: number): void;
  before(fn: Body): void;
  after(fn: Body): void;
  skipDescribe(name: string, fn: () => void): void;
  skipTest(name: string, fn: Body): void;
}

/** The `bun:test` module as Bun hands it to ONE test file. */
export interface BunTestModule {
  describe: ((name: string, fn: () => void) => void) & { skip(name: string, fn: () => void): void };
  test: ((name: string, fn: Body, timeoutMs?: number) => void) & { skip(name: string, fn: Body): void };
  beforeAll(fn: Body): void;
  afterAll(fn: Body): void;
}

export interface Harness {
  describe(name: string, optionsOrFn: Options | (() => void), maybeFn?: () => void): void;
  test(name: string, fn: Body): void;
  before(fn: Body): void;
  after(fn: Body): void;
}

/**
 * The harness for one test file. Under Bun, pass THAT FILE's own `bun:test` module: Bun scopes it per
 * importing file, so a module shared between files must never import it itself. Under Node, pass
 * nothing. Each test file therefore starts with:
 *
 *     const { describe, test } = await harness(isBun ? await import(BUN_TEST) : undefined);
 */
export async function harness(bunTest: BunTestModule | undefined): Promise<Harness> {
  let api: Api;
  if (bunTest !== undefined) {
    const b = bunTest;
    api = { describe: b.describe, test: b.test, before: b.beforeAll, after: b.afterAll, skipDescribe: (n, f) => b.describe.skip(n, f), skipTest: (n, f) => b.test.skip(n, f) };
  } else {
    const n = await import("node:test");
    api = {
      describe: (name, fn) => void n.describe(name, fn),
      test: (name, fn, timeoutMs) => void n.test(name, timeoutMs !== undefined ? { timeout: timeoutMs } : {}, fn),
      before: (fn) => void n.before(fn),
      after: (fn) => void n.after(fn),
      skipDescribe: (name, fn) => void n.describe(name, { skip: true }, fn),
      skipTest: (name, fn) => void n.test(name, { skip: true }, fn),
    };
  }
  return {
    describe(name, optionsOrFn, maybeFn) {
      const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn!;
      const skip = typeof optionsOrFn === "function" ? false : optionsOrFn.skip;
      if (skip !== undefined && skip !== false) api.skipDescribe(`${name} (skipped: ${skip})`, fn);
      else api.describe(name, fn);
    },
    test: (name, fn) => api.test(name, fn, 30_000),
    before: (fn) => api.before(fn),
    after: (fn) => api.after(fn),
  };
}

export const isBun = typeof (process.versions as Record<string, string | undefined>)["bun"] === "string";
/** The specifier, built at run time so Node never resolves it. */
export const BUN_TEST = ["bun", "test"].join(":");
