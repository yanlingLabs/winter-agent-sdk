// The xAI device-authorization double, re-exported under the name the corpus uses.
//
// The IMPLEMENTATION lives next to the adapter, in
// `provider-runtime/src/adapters/openai/xai-oauth.testing.ts`, for the reason
// `adapters/openai/testing.ts` already states in its own header: both packages' fixtures need it,
// and the dependency runs conformance -> provider-runtime, never the other way. Putting it here and
// importing it from a provider-runtime test would be a package cycle.
//
// review r1 (Critical-2): reached via the new `@yanlinglabs/winter-provider-runtime/testing`
// subpath rather than a relative path that escapes this package's own boundary -- the relative form
// threw `Cannot find module` the moment this package was packed and installed standalone (the
// tarball never contains `../../../provider-runtime`), reproduced against a real packed tarball.
//
// A file that only re-exports is worth its existence here: the brief names this path, the corpus
// imports every other fake from `../fakes/`, and a reader looking for "where is the xAI fake" finds
// it beside the other twelve rather than having to know about the dependency direction.

export { startXaiOauthFake } from "@yanlinglabs/winter-provider-runtime/testing";
export type { XaiOauthFake, XaiOauthFakeOptions, XaiRecordedRequest } from "@yanlinglabs/winter-provider-runtime/testing";
