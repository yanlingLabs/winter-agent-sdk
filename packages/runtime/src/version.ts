// WS-23: the runtime PACKAGE's own version, in a module that imports nothing.
//
// An embedding host asserts at boot that this, the wrapper's `SDK_VERSION` and its own pin agree (the
// three packages publish together at one version, with exact pins between them). It must be able to
// read the value on its MAIN thread without evaluating the runtime graph there -- hence a module of its
// own rather than `store/dialect.ts`'s `RUNTIME_ENGINE_VERSION`, which carries the whole store with it.
//
// Hardcoded rather than read from package.json for the reason `SDK_VERSION` is (a `$bunfs` binary
// cannot read a manifest by relative path); `version:sync` stamps it and `version.test.ts` pins it to
// the manifest and to `RUNTIME_ENGINE_VERSION`.
export const RUNTIME_VERSION = "0.0.26";
